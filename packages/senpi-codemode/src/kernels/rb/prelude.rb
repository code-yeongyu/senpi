require "base64"
require "fileutils"
require "json"
require "uri"

SENPI_RESERVED_AGENT_TOOL = "__agent__"
SENPI_RESERVED_OUTPUT_TOOL = "__output__"
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

def __senpi_resolve_path(value)
  raw = value.to_s
  match = SENPI_INTERNAL_URL.match(raw)
  return File.expand_path(raw) unless match

  scheme = match[1].downcase
  roots = $__senpi_connection.is_a?(Hash) ? $__senpi_connection["localRoots"] : nil
  root = roots[scheme] if roots.is_a?(Hash)
  raise "Protocol paths are not supported by this helper: #{raw}" unless root.is_a?(String) && !root.empty?

  relative = URI::DEFAULT_PARSER.unescape(match[2].tr("\\", "/"))
  root_path = File.expand_path(root)
  return root_path if relative.empty?
  if relative.start_with?("/") || relative.split("/").include?("..")
    raise "Unsafe #{scheme}:// path (absolute or traversal): #{raw}"
  end

  resolved = File.expand_path(relative, root_path)
  unless resolved == root_path || resolved.start_with?(root_path + File::SEPARATOR)
    raise "#{scheme}:// path escapes its root: #{raw}"
  end
  resolved
end

def __senpi_display_payload(value)
  if value.is_a?(Hash)
    kind = value["type"] || value[:type]
    text_value = value["text"] || value[:text]
    return ["text/markdown", text_value.to_s] if kind == "markdown" && !text_value.nil?
    return ["image/png", value["data"].to_s] if kind == "image" && value["mimeType"] == "image/png"
    return ["image/jpeg", value["data"].to_s] if kind == "image" && value["mimeType"] == "image/jpeg"
    return ["application/json", JSON.generate(value)]
  end
  return ["application/json", JSON.generate(value)] if value.is_a?(Array)
  ["text/plain", value.to_s]
end

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
  __senpi_emit_status("read", "path" => resolved, "chars" => data.length, "preview" => data[0, 500].to_s)
  data
end

def write(path, content)
  resolved = __senpi_resolve_path(path)
  FileUtils.mkdir_p(File.dirname(resolved))
  data = content.to_s
  File.write(resolved, data)
  __senpi_emit_status("write", "path" => resolved, "chars" => data.length)
  resolved
end

def env(key = nil, value = nil)
  if key.nil?
    entries = ENV.to_h.sort.to_h
    __senpi_emit_status("env", "count" => entries.length, "keys" => entries.keys.first(20))
    return entries
  end

  name = key.to_s
  if value.nil?
    resolved = ENV[name]
    __senpi_emit_status("env", "key" => name, "value" => resolved, "action" => "get")
    return resolved
  end

  resolved = value.to_s
  ENV[name] = resolved
  __senpi_emit_status("env", "key" => name, "value" => resolved, "action" => "set")
  resolved
end

def __senpi_bridge_request(path, payload)
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
    response = Net::HTTP.start(uri.hostname, uri.port, open_timeout: 10, read_timeout: 60) { |http| http.request(request) }
  ensure
    __senpi_emit_status("timeout-resume", force: true)
  end
  body = JSON.parse(response.body.to_s)
  return body["value"] if body.is_a?(Hash) && body["ok"] == true

  error = body.is_a?(Hash) ? body["error"] : body
  raise(error.is_a?(Hash) ? error["message"].to_s : error.to_s)
end

def __senpi_call_tool(name, args)
  __senpi_bridge_request("/call", { "callId" => "rb-#{Process.pid}-#{rand(1_000_000)}", "toolName" => name, "args" => args })
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

def completion(prompt, model: "default", system: nil, schema: nil, **kwargs)
  options = { "model" => model }.merge(kwargs.transform_keys(&:to_s))
  options["system"] = system unless system.nil?
  options["schema"] = schema unless schema.nil?
  result = __senpi_bridge_request("/completion", { "prompt" => prompt.to_s, "opts" => options })
  return result unless schema
  JSON.parse(result.is_a?(Hash) ? result.fetch("text", result).to_s : result.to_s)
end

def output(*ids, format: "raw", offset: nil, limit: nil)
  raise ArgumentError, "At least one output ID is required" if ids.empty?
  raise ArgumentError, "output() format must be 'raw' or 'tail'" unless ["raw", "tail"].include?(format)
  args = { "ids" => ids.map(&:to_s), "format" => format }
  args["offset"] = offset unless offset.nil?
  args["limit"] = limit unless limit.nil?
  __senpi_call_tool(SENPI_RESERVED_OUTPUT_TOOL, args)
end

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
  { "text" => text_value, "output" => text_value, "handle" => record["handle"] || (record["id"] && "agent://#{record["id"]}"), "id" => record["id"], "agent" => record.fetch("agent", agent) }.tap do |node|
    node["data"] = result unless schema.nil?
  end
end

def __senpi_pool_map(items, width)
  values = items.to_a
  return [] if values.empty?
  workers = [[width.to_i, 1].max, values.length].min
  results = Array.new(values.length)
  failures = {}
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
          failures[index] = error
        end
      end
    end
  end
  threads.each(&:join)
  raise failures[failures.keys.min] unless failures.empty?
  results
end

def parallel(thunks, width: 4)
  __senpi_pool_map(thunks, width) do |thunk|
    raise TypeError, "parallel() expects zero-arg callables" unless thunk.respond_to?(:call)
    thunk.call
  end
end

def pipeline(items, *stages)
  stages.reduce(items.to_a) do |values, stage|
    raise TypeError, "pipeline() stages must be callables" unless stage.respond_to?(:call)
    __senpi_pool_map(values, 4) { |value| stage.call(value) }
  end
end

def log(message)
  __senpi_emit({ "type" => "log", "message" => message.to_s })
  nil
end

def phase(title)
  __senpi_emit({ "type" => "phase", "title" => title.to_s })
  nil
end
