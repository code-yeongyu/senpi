# Path resolution (local:// roots) and display payload shaping for the Ruby prelude helpers.
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
