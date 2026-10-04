require "base64"
require "fileutils"
require "json"
require "uri"

SENPI_RESERVED_AGENT_TOOL = "__agent__"
SENPI_RESERVED_OUTPUT_TOOL = "__output__"
SENPI_RESERVED_SCHEMA_TOOL = "__schema__"
SENPI_INTERNAL_URL = Regexp.new("\\A([a-z][a-z0-9+.\\-]*)://(.*)\\z", Regexp::IGNORECASE)

def __senpi_status_enabled?
  connection = $__senpi_connection
  return true unless connection.is_a?(Hash)
  connection["statusEvents"] != false
end

def __senpi_emit_status(op, fields = {}, force: false)
  return unless force || __senpi_status_enabled?
  __senpi_emit({ "type" => "status", "event" => { "op" => op }.merge(fields.transform_keys(&:to_s)) })
end

require_relative "paths"

def display(value)
  mime_type, payload = __senpi_display_payload(value)
  data_base64 = mime_type.start_with?("image/") ? payload : Base64.strict_encode64(payload)
  __senpi_emit({ "type" => "display", "mimeType" => mime_type, "dataBase64" => data_base64 })
  nil
end

def display_image(base64, mime_type: "image/png")
  __senpi_emit({ "type" => "display", "mimeType" => mime_type.to_s, "dataBase64" => base64.to_s })
  nil
end

def text(data)
  __senpi_emit({ "type" => "text", "stream" => "stdout", "data" => data.to_s })
  nil
end

def print(*values)
  text(values.join)
end

def read(path, offset = 1, limit = nil)
  resolved = __senpi_resolve_path(path)
  data = File.read(resolved, encoding: Encoding::UTF_8)
  if offset > 1 || !limit.nil?
    lines = data.lines
    start = [offset.to_i - 1, 0].max
    data = lines[start, limit || lines.length].to_a.join
  end
  __senpi_emit_status("read", { "path" => resolved, "chars" => data.length, "preview" => data[0, 500].to_s })
  data
end

def write(path, content)
  resolved = __senpi_resolve_path(path)
  FileUtils.mkdir_p(File.dirname(resolved))
  data = content.to_s
  File.write(resolved, data)
  __senpi_emit_status("write", { "path" => resolved, "chars" => data.length })
  resolved
end

def env(key = nil, value = nil)
  if key.nil?
    entries = ENV.to_h.sort.to_h
    __senpi_emit_status("env", { "count" => entries.length, "keys" => entries.keys.first(20) })
    return entries
  end

  name = key.to_s
  if value.nil?
    resolved = ENV[name]
    __senpi_emit_status("env", { "key" => name, "value" => resolved, "action" => "get" })
    return resolved
  end

  resolved = value.to_s
  ENV[name] = resolved
  __senpi_emit_status("env", { "key" => name, "value" => resolved, "action" => "set" })
  resolved
end

def __senpi_bridge_request(path, payload, read_timeout: 60)
  connection = $__senpi_connection
  raise "Ruby tool bridge is not initialized" unless connection.is_a?(Hash)
  port = connection["port"]
  token = connection["token"]
  raise "Ruby tool bridge is not initialized" unless port.is_a?(Integer) && token.is_a?(String)

  uri = URI("http://127.0.0.1:#{port}#{path}")
  request = Net::HTTP::Post.new(uri)
  request["authorization"] = "Bearer #{token}"
  request["content-type"] = "application/json"
  request.body = JSON.generate(payload)
  __senpi_emit_status("timeout-pause", force: true)
  begin
    response = Net::HTTP.start(uri.hostname, uri.port, open_timeout: 10, read_timeout: read_timeout) { |http| http.request(request) }
  ensure
    __senpi_emit_status("timeout-resume", force: true)
  end
  body = JSON.parse(response.body.to_s)
  return body["value"] if body.is_a?(Hash) && body["ok"] == true

  error = body.is_a?(Hash) ? body["error"] : body
  raise SenpiBridgeError.new(error.is_a?(Hash) ? error["message"].to_s : error.to_s, error.is_a?(Hash) ? error["code"] : nil)
end

def __senpi_call_tool(name, args)
  __senpi_bridge_request("/call", { "callId" => "rb-#{Process.pid}-#{rand(1_000_000)}", "toolName" => name, "args" => args })
end

class SenpiBridgeError < StandardError
  attr_reader :code

  def initialize(message, code = nil)
    super(message)
    @code = code
  end
end

class SenpiToolCallable
  def initialize(name)
    @name = name
  end

  def call(args = nil, **kwargs)
    merged = args.nil? ? {} : args.is_a?(Hash) ? args.transform_keys(&:to_s) : raise(ArgumentError, "tool.#{@name}(...) expects a Hash of arguments")
    kwargs.each { |key, value| merged[key.to_s] = value }
    __senpi_call_tool(@name, merged)
  end
end

class SenpiToolProxy < BasicObject
  def method_missing(name, args = nil, **kwargs)
    ::SenpiToolCallable.new(name.to_s).call(args, **kwargs)
  end

  def [](name)
    ::SenpiToolCallable.new(name.to_s)
  end

  def respond_to_missing?(_name, _private = false)
    true
  end
end

def tool
  $__senpi_tool_proxy ||= SenpiToolProxy.new
end

require_relative "workpool"
require_relative "handles"

# Block until the handles settle; never cancels work. See tool_schema("eval:wait").
def wait(handles, timeout: nil, mode: "all")
  __senpi_wait(handles, timeout: timeout, mode: mode)
end

# Rich view of an agent record, workpool, completion handle or saved reference; see tool_schema("eval:helpers").
def handle(value)
  __senpi_handle_view(value)
end

def completion(prompt, model: "default", system: nil, schema: nil, **kwargs)
  options = { "model" => model }.merge(kwargs.transform_keys(&:to_s))
  options["system"] = system unless system.nil?
  options["schema"] = schema unless schema.nil?
  result = __senpi_bridge_request("/completion", { "prompt" => prompt.to_s, "opts" => options })
  return handle(result) if options["handle"] == true
  return result unless result.is_a?(Hash)
  return result["value"] if result.key?("value")

  result.fetch("text", result)
end

def tool_schema(name = nil)
  args = name.nil? ? {} : { "name" => name.to_s }
  __senpi_call_tool(SENPI_RESERVED_SCHEMA_TOOL, args)
end

def output(*ids, format: "raw", offset: nil, limit: nil)
  raise ArgumentError, "At least one output ID is required" if ids.empty?
  raise ArgumentError, "output() format must be 'raw' or 'tail'" unless ["raw", "tail"].include?(format)
  args = { "ids" => ids.map(&:to_s), "format" => format }
  args["offset"] = offset unless offset.nil?
  args["limit"] = limit unless limit.nil?
  __senpi_call_tool(SENPI_RESERVED_OUTPUT_TOOL, args)
end

# isolated/apply/merge need a host that supports isolation; otherwise a warning.
# merge: "patch"/"branch" (false/true aliases). Unapplied foreground changes raise
# an error with recovery instructions. Handles return immediately: await completion
# notification or read task_output for the isolation result.
def agent(prompt, agent: "task", model: nil, label: nil, schema: nil, isolated: nil, apply: nil, merge: nil, handle: false)
  args = { "prompt" => prompt.to_s, "agent" => agent }
  { "model" => model, "label" => label, "schema" => schema, "isolated" => isolated, "apply" => apply, "merge" => merge }.each do |key, value|
    args[key] = value unless value.nil?
  end
  args["handle"] = true if handle
  response = __senpi_call_tool(SENPI_RESERVED_AGENT_TOOL, args)
  record = response.is_a?(Hash) ? response : {}
  text_value = record.fetch("text", response)
  result = schema.nil? ? text_value : record.key?("data") ? record["data"] : JSON.parse(text_value.to_s)
  return result unless handle
  { "text" => text_value, "output" => text_value, "handle" => record["handle"] || (record["id"] && "agent://#{record["id"]}"), "id" => record["id"], "run_epoch" => record["run_epoch"], "agent" => record.fetch("agent", agent) }.tap do |node|
    node["data"] = result unless schema.nil?
    details = record["details"]
    node["details"] = { "isolation" => details["isolation"] } if details.is_a?(Hash) && details.key?("isolation")
  end
end

def __senpi_pool_map(items)
  values = items.to_a
  return [] if values.empty?
  connection = $__senpi_connection
  configured_width = connection.is_a?(Hash) ? connection["parallelPoolWidth"] : nil
  width = configured_width.is_a?(Numeric) ? configured_width.to_i : 4
  workers = [[width, 1].max, values.length].min
  results = Array.new(values.length)
  failures = {}
  failure_mutex = Mutex.new
  queue = Queue.new
  values.each_index { |index| queue << index }
  threads = workers.times.map do
    Thread.new do
      loop do
        index = queue.pop(true) rescue nil
        break if index.nil?
        begin
          results[index] = yield(values[index])
        rescue Exception => error
          failure_mutex.synchronize { failures[index] = error }
        end
      end
    end
  end
  threads.each(&:join)
  raise failures[failures.keys.min] unless failures.empty?
  results
end

def parallel(thunks)
  values = thunks.to_a
  values.each do |thunk|
    raise TypeError, "parallel() expects an iterable of zero-arg callables" unless thunk.respond_to?(:call)
  end
  __senpi_pool_map(values) { |thunk| thunk.call }
end

def pipeline(items, *stages)
  values = items.to_a
  stages.each do |stage|
    raise TypeError, "pipeline() stages must be callables" unless stage.respond_to?(:call)
    values = __senpi_pool_map(values) { |value| stage.call(value) }
  end
  values
end

def log(message)
  __senpi_emit({ "type" => "log", "message" => message.to_s })
  nil
end

def phase(title)
  __senpi_emit({ "type" => "phase", "title" => title.to_s })
  nil
end
