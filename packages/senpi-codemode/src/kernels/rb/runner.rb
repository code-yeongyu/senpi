require "json"
require "net/http"
require "uri"

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

$__senpi_protocol_stdin.each_line do |line|
  message = JSON.parse(line)
  case message["type"]
  when "init"
    $__senpi_connection = message["connection"]
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
