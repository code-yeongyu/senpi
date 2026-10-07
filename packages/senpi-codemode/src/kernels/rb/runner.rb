$stdout.write("{\"type\":\"status\",\"event\":{\"op\":\"kernel-startup\",\"stage\":\"stdlib-imports\"}}\n")
$stdout.flush
require "json"
require "net/http"
require "uri"
$stdout.write("{\"type\":\"status\",\"event\":{\"op\":\"kernel-startup\",\"stage\":\"runtime-init\"}}\n")
$stdout.flush

$__senpi_binding = TOPLEVEL_BINDING
$__senpi_frame_mutex = Mutex.new
$__senpi_current_cell = nil
$__senpi_capture_cell = nil
$__senpi_connection = nil
$__senpi_frame_io = STDOUT.dup
$__senpi_frame_io.sync = true

begin
  stdout_read, stdout_write = IO.pipe
  STDOUT.reopen(stdout_write)
  STDOUT.sync = true
  stdout_write.close
  $__senpi_stdout_capture = stdout_read
rescue StandardError
  $__senpi_stdout_capture = nil
end

begin
  stderr_read, stderr_write = IO.pipe
  STDERR.reopen(stderr_write)
  STDERR.sync = true
  stderr_write.close
  $__senpi_stderr_capture = stderr_read
rescue StandardError
  $__senpi_stderr_capture = nil
end

begin
  $__senpi_protocol_stdin = STDIN.dup
  STDIN.reopen(File.open(File::NULL, "r"))
rescue StandardError
  $__senpi_protocol_stdin = STDIN
end

def __senpi_emit(frame)
  line = JSON.generate(frame)
  $__senpi_frame_mutex.synchronize do
    $__senpi_frame_io.write(line)
    $__senpi_frame_io.write("\n")
    $__senpi_frame_io.flush
  end
rescue StandardError
  nil
end

def __senpi_error(error)
  { "name" => error.class.name, "message" => error.message.to_s, "stack" => error.backtrace&.join("\n") }
end

def __senpi_emit_stream(stream, data)
  return if data.nil? || data.empty? || $__senpi_capture_cell.nil?
  __senpi_emit({ "type" => "text", "stream" => stream, "data" => data })
end

class SenpiStreamProxy
  def initialize(stream)
    @stream = stream
  end

  def write(*values)
    data = values.join
    __senpi_emit_stream(@stream, data)
    data.bytesize
  end

  def print(*values)
    write(*values)
    nil
  end

  def puts(*values)
    values = [""] if values.empty?
    values.each { |value| write(value.to_s.end_with?("\n") ? value.to_s : "#{value}\n") }
    nil
  end

  def printf(format, *values)
    write(Kernel.format(format, *values))
    nil
  end

  def flush
    self
  end

  def sync
    true
  end

  def sync=(_value)
    true
  end

  def tty?
    false
  end
end

def __senpi_start_capture(io, stream)
  return if io.nil?
  Thread.new do
    loop do
      data = io.readpartial(65_536)
      __senpi_emit_stream(stream, data)
    rescue EOFError, IOError, Errno::EBADF
      break
    end
  end
end

def __senpi_value_repr(value)
  JSON.generate(value)
rescue JSON::GeneratorError
  value.inspect
end

$__senpi_memory = nil

SENPI_SIZER_SAMPLE = 1_000
SENPI_SIZER_NODE_BUDGET = 5_000
SENPI_SIZER_MAX_DEPTH = 64
SENPI_SIZER_POINTER = 8
SENPI_SIZER_OBJECT = 40
SENPI_SIZER_MIN_REPORTED = 1024 * 1024
SENPI_ARRAY_AT = Array.instance_method(:[])
SENPI_ARRAY_SIZE = Array.instance_method(:size)
SENPI_HASH_SIZE = Hash.instance_method(:size)
SENPI_HASH_EACH = Hash.instance_method(:each_pair)
SENPI_STRING_BYTESIZE = String.instance_method(:bytesize)
SENPI_IVARS = Kernel.instance_method(:instance_variables)
SENPI_IVAR_GET = Kernel.instance_method(:instance_variable_get)

# Sizes a global without running user code: built-ins are read through their own unbound methods, so an
# override in a subclass is never called. Collections are sampled, and each global gets its own node
# budget (leaves count against it too), so one deep global never hides the ones measured after it.
class SenpiGlobalSizer
  attr_reader :approximate

  def initialize
    @seen = {}.compare_by_identity
    @nodes = 0
    @approximate = false
  end

  def measure(value)
    @approximate = false
    @nodes = 0
    SENPI_SIZER_POINTER + size(value, 0)
  end

  private

  def size(value, depth)
    @nodes += 1
    return 0 if NilClass === value || TrueClass === value || FalseClass === value || Symbol === value
    return ObjectSpace.memsize_of(value) if Integer === value || Float === value
    return 0 if @seen.key?(value)
    @seen[value] = true
    return SENPI_SIZER_OBJECT + SENPI_STRING_BYTESIZE.bind(value).call() if String === value
    if depth >= SENPI_SIZER_MAX_DEPTH || @nodes >= SENPI_SIZER_NODE_BUDGET
      @approximate = true
      return ObjectSpace.memsize_of(value)
    end
    if Array === value
      length = SENPI_ARRAY_SIZE.bind(value).call()
      SENPI_SIZER_OBJECT + length * SENPI_SIZER_POINTER + sampled(length, depth) { |index| SENPI_ARRAY_AT.bind(value).call(index) }
    elsif Hash === value
      hash_size(value, depth)
    else
      ivars = SENPI_IVARS.bind(value).call()
      ObjectSpace.memsize_of(value) + sampled(ivars.length, depth) { |index| SENPI_IVAR_GET.bind(value).call(ivars[index]) }
    end
  end

  def hash_size(hash, depth)
    count = SENPI_HASH_SIZE.bind(hash).call()
    taken = 0
    total = 0
    SENPI_HASH_EACH.bind(hash).call() do |key, item|
      total += size(key, depth + 1) + size(item, depth + 1)
      taken += 1
      break if taken >= SENPI_SIZER_SAMPLE
    end
    @approximate = true if taken < count
    SENPI_SIZER_OBJECT + count * 2 * SENPI_SIZER_POINTER + (taken.zero? ? 0 : total * count / taken)
  end

  # Up to SENPI_SIZER_SAMPLE evenly spaced elements; when the walk budget runs out part-way, the elements
  # measured so far stand in for the rest, so a cut-short container is scaled up, not under-counted.
  def sampled(length, depth)
    return 0 if length.zero?
    picks = [length, SENPI_SIZER_SAMPLE].min
    @approximate = true if picks < length
    step = length.to_f / picks
    total = 0
    measured = 0
    picks.times do |sample|
      if @nodes >= SENPI_SIZER_NODE_BUDGET
        @approximate = true
        break
      end
      total += size(yield((sample * step).floor), depth + 1)
      measured += 1
    end
    measured.zero? ? 0 : (total.to_f / measured * length).round
  end
end

def __senpi_largest_globals(limit)
  require "objspace"
  sizer = SenpiGlobalSizer.new
  sized = []
  measure = lambda do |name, value|
    bytes = sizer.measure(value)
    next if bytes < SENPI_SIZER_MIN_REPORTED
    entry = { "name" => name, "bytes" => bytes }
    entry["approximate"] = true if sizer.approximate
    sized << entry
  end
  $__senpi_binding.local_variables.each do |name|
    next if $__senpi_memory_baseline_locals.include?(name)
    measure.call(name.to_s, $__senpi_binding.local_variable_get(name))
  end
  global_variables.each do |name|
    next if $__senpi_memory_baseline_globals.include?(name) || name.to_s.start_with?("$__senpi_")
    measure.call(name.to_s, eval(name.to_s))
  end
  sized.sort_by { |entry| -entry["bytes"] }.first(limit)
rescue StandardError
  []
end

# The host reads the interpreter's footprint and decides on the notice; the runner only names its
# largest globals. Nothing here spawns a process, so the user's `$?` is left alone.
def __senpi_memory_report
  return nil if $__senpi_memory.nil?
  named = __senpi_largest_globals(5)
  # The host replaces liveBytes with the interpreter footprint it reads itself; only globals is used.
  report = { "liveBytes" => 0, "measure" => "footprint" }
  report["globals"] = named unless named.empty?
  report
rescue StandardError
  nil
end

SENPI_NON_DISPLAY_NODES = %i[
  LASGN IASGN GASGN CVASGN DASGN OP_ASGN OP_CDECL CDECL MASGN CASGN
  DEFN DEFS CLASS MODULE SCLASS ALIAS UNDEF
].freeze

def __senpi_ast_last(node)
  return nil unless node.is_a?(RubyVM::AbstractSyntaxTree::Node)
  case node.type
  when :SCOPE
    __senpi_ast_last(node.children[2])
  when :BLOCK
    children = node.children.compact
    children.empty? ? nil : __senpi_ast_last(children.last)
  else
    node
  end
end

def __senpi_should_display_result?(source)
  return true unless defined?(RubyVM::AbstractSyntaxTree)
  node = RubyVM::AbstractSyntaxTree.parse(source)
  last = __senpi_ast_last(node)
  return true if last.nil?
  !SENPI_NON_DISPLAY_NODES.include?(last.type)
rescue StandardError, SyntaxError
  true
end

require_relative "prelude"

$stdout = SenpiStreamProxy.new("stdout")
$stderr = SenpiStreamProxy.new("stderr")
__senpi_start_capture($__senpi_stdout_capture, "stdout")
__senpi_start_capture($__senpi_stderr_capture, "stderr")

def __senpi_run_cell(message)
  started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
  cell_id = message["cellId"].to_s
  $__senpi_current_cell = cell_id
  $__senpi_capture_cell = cell_id
  begin
    source = message["code"].to_s
    value = eval(source, $__senpi_binding, "(senpi-rb)")
    STDOUT.flush
    STDERR.flush
    Thread.pass
    frame = {
      "type" => "result",
      "cellId" => cell_id,
      "ok" => true,
      "durationMs" => ((Process.clock_gettime(Process::CLOCK_MONOTONIC) - started) * 1000).round,
    }
    frame["valueRepr"] = __senpi_value_repr(value) if !value.nil? && __senpi_should_display_result?(source)
    memory = __senpi_memory_report
    frame["memory"] = memory unless memory.nil?
    __senpi_emit(frame)
  rescue Exception => error
    __senpi_emit({
      "type" => "result",
      "cellId" => cell_id,
      "ok" => false,
      "error" => __senpi_error(error),
      "durationMs" => ((Process.clock_gettime(Process::CLOCK_MONOTONIC) - started) * 1000).round,
    })
  ensure
    $__senpi_capture_cell = nil
    $__senpi_current_cell = nil
  end
end

# Everything defined so far belongs to the runner or the interpreter, never to the user's cells.
$__senpi_memory_baseline_locals = $__senpi_binding.local_variables
$__senpi_memory_baseline_globals = global_variables

$__senpi_protocol_stdin.each_line do |line|
  message = JSON.parse(line)
  case message["type"]
  when "init"
    __senpi_emit({ "type" => "status", "event" => { "op" => "kernel-startup", "stage" => "host-init" } })
    $__senpi_connection = message["connection"]
    $__senpi_memory = message["memory"]
    __senpi_emit({ "type" => "ready" })
  when "run"
    __senpi_run_cell(message)
  when "close"
    __senpi_emit({ "type" => "closed" })
    exit 0
  end
rescue JSON::ParserError => error
  __senpi_emit({ "type" => "init-failed", "error" => __senpi_error(error) })
end
