require "json"
require "net/http"
require "stringio"
require "uri"
require_relative "prelude"

$__senpi_binding = TOPLEVEL_BINDING
$__senpi_mutex = Mutex.new
$__senpi_current_cell = nil
$__senpi_connection = nil

def __senpi_emit(frame)
  STDOUT.write(JSON.generate(frame))
  STDOUT.write("\n")
  STDOUT.flush
end

def __senpi_error(error)
  { "name" => error.class.name, "message" => error.message, "stack" => error.backtrace&.join("\n") }
end

def __senpi_call_tool(name, args)
  connection = $__senpi_connection
  raise "Ruby tool bridge is not initialized" unless connection.is_a?(Hash)
  port = connection["port"]
  token = connection["token"]
  raise "Ruby tool bridge is not initialized" unless port.is_a?(Integer) && token.is_a?(String)

  call_id = "#{Time.now.to_i}-#{rand(1_000_000)}"
  uri = URI("http://127.0.0.1:#{port}/call")
  request = Net::HTTP::Post.new(uri)
  request["authorization"] = "Bearer #{token}"
  request["content-type"] = "application/json"
  request.body = JSON.generate({ "callId" => call_id, "toolName" => name, "args" => args })
  response = Net::HTTP.start(uri.hostname, uri.port, read_timeout: 60) { |http| http.request(request) }
  body = JSON.parse(response.body.to_s)
  return body["value"] if body.is_a?(Hash) && body["ok"] == true

  error = body.is_a?(Hash) ? body["error"] : body
  if error.is_a?(Hash)
    raise error["message"].to_s
  end
  raise error.to_s
end

# Capture the cell's $stdout writes (puts/print) and emit them as `text` frames.
# $stdout is redirected to a buffer during eval so user output never contaminates
# the JSONL protocol channel, which __senpi_emit writes to via the STDOUT constant
# (the STDOUT constant is unaffected by reassigning the $stdout global).
def __senpi_run_cell(message)
  started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
  $__senpi_current_cell = message["cellId"]
  captured = StringIO.new
  previous_stdout = $stdout
  $stdout = captured
  begin
    value = eval(message["code"].to_s, $__senpi_binding, "(senpi-rb)")
    $stdout = previous_stdout
    __senpi_flush_stdout(captured)
    frame = {
      "type" => "result",
      "cellId" => message["cellId"],
      "ok" => true,
      "durationMs" => ((Process.clock_gettime(Process::CLOCK_MONOTONIC) - started) * 1000).round,
    }
    frame["valueRepr"] = JSON.generate(value) unless value.nil?
    __senpi_emit(frame)
  rescue Exception => error
    $stdout = previous_stdout
    __senpi_flush_stdout(captured)
    __senpi_emit({
      "type" => "result",
      "cellId" => message["cellId"],
      "ok" => false,
      "error" => __senpi_error(error),
      "durationMs" => ((Process.clock_gettime(Process::CLOCK_MONOTONIC) - started) * 1000).round,
    })
  ensure
    $stdout = previous_stdout
    $__senpi_current_cell = nil
  end
end

def __senpi_flush_stdout(captured)
  data = captured.string
  __senpi_emit({ "type" => "text", "stream" => "stdout", "data" => data }) unless data.empty?
end

STDIN.each_line do |line|
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
end
