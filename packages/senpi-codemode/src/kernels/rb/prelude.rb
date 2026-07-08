require "base64"
require "json"

def display(value)
  payload = Base64.strict_encode64(JSON.generate(value))
  __senpi_emit({ "type" => "display", "mimeType" => "application/json", "dataBase64" => payload })
  nil
end

def print(*values)
  __senpi_emit({ "type" => "text", "stream" => "stdout", "data" => values.join })
  nil
end

def read(path)
  File.read(path.to_s)
end

def write(path, content)
  File.write(path.to_s, content.to_s)
  path.to_s
end

def env(key = nil, value = nil)
  return ENV.to_h if key.nil?
  if value.nil?
    ENV[key.to_s]
  else
    ENV[key.to_s] = value.to_s
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

class SenpiToolProxy < BasicObject
  def method_missing(name, args = nil, **kwargs)
    merged = args.is_a?(::Hash) ? args.transform_keys(&:to_s) : {}
    kwargs.each { |key, value| merged[key.to_s] = value }
    ::Object.__send__(:__senpi_call_tool, name.to_s, merged)
  end

  def respond_to_missing?(_name, _private = false)
    true
  end
end

def tool
  $__senpi_tool_proxy ||= SenpiToolProxy.new
end
