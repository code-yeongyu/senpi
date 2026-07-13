# allow: SIZE_OK — this dependency-free kernel prelude is loaded as one runtime asset.
const SENPI_B64_ALPHABET = collect("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/")

function senpi_base64(text::AbstractString)
    bytes = codeunits(text)
    out = IOBuffer()
    index = 1
    while index <= length(bytes)
        first_byte = bytes[index]
        second_byte = index + 1 <= length(bytes) ? bytes[index + 1] : UInt8(0)
        third_byte = index + 2 <= length(bytes) ? bytes[index + 2] : UInt8(0)
        Base.write(out, SENPI_B64_ALPHABET[(first_byte >> 2) + 1])
        Base.write(out, SENPI_B64_ALPHABET[(((first_byte & 0x03) << 4) | (second_byte >> 4)) + 1])
        Base.write(out, index + 1 <= length(bytes) ? SENPI_B64_ALPHABET[(((second_byte & 0x0f) << 2) | (third_byte >> 6)) + 1] : '=')
        Base.write(out, index + 2 <= length(bytes) ? SENPI_B64_ALPHABET[(third_byte & 0x3f) + 1] : '=')
        index += 3
    end
    String(take!(out))
end

function senpi_status_events_enabled()
    get(senpi_connection, "statusEvents", true) !== false
end

function senpi_emit_status(op::AbstractString, fields::AbstractDict=Dict{String, Any}(); force::Bool=false)
    (force || senpi_status_events_enabled()) || return nothing
    event = Dict{String, Any}("op" => string(op))
    for (key, value) in fields
        event[string(key)] = value
    end
    senpi_emit(Dict("type" => "status", "event" => event))
    nothing
end

function senpi_with_bridge_timeout_pause(operation::Function)
    senpi_emit_status("timeout-pause"; force=true)
    try
        return operation()
    finally
        senpi_emit_status("timeout-resume"; force=true)
    end
end

function senpi_url_decode(value::AbstractString)
    out = IOBuffer()
    index = 1
    while index <= ncodeunits(value)
        character = Char(codeunit(value, index))
        if character == '%' && index + 2 <= ncodeunits(value)
            hex = value[index + 1:index + 2]
            parsed = tryparse(UInt8, hex; base=16)
            if parsed !== nothing
                Base.write(out, parsed)
                index += 3
                continue
            end
        end
        Base.write(out, character)
        index += 1
    end
    String(take!(out))
end

function senpi_resolve_path(value::AbstractString)
    raw = string(value)
    matched = match(r"^([a-z][a-z0-9+.\-]*)://(.*)$"i, raw)
    matched === nothing && return abspath(raw)
    scheme = lowercase(string(matched.captures[1]))
    roots = get(senpi_connection, "localRoots", nothing)
    root = roots isa AbstractDict ? get(roots, scheme, nothing) : nothing
    root isa AbstractString && !isempty(root) || error("Protocol paths are not supported by this helper: $raw")
    relative = senpi_url_decode(replace(string(matched.captures[2]), '\\' => '/'))
    root_path = abspath(string(root))
    isempty(relative) && return root_path
    (startswith(relative, '/') || ".." in split(relative, '/')) && error("Unsafe $scheme:// path (absolute or traversal): $raw")
    resolved = abspath(joinpath(root_path, relative))
    (resolved == root_path || startswith(resolved, root_path * string(Base.Filesystem.path_separator))) || error("$scheme:// path escapes its root: $raw")
    resolved
end

function senpi_display_payload(value)
    if value isa AbstractDict
        kind = get(value, "type", get(value, :type, nothing))
        text_value = get(value, "text", get(value, :text, nothing))
        if kind == "markdown" && text_value !== nothing
            return "text/markdown", string(text_value), false
        end
        mime_type = get(value, "mimeType", get(value, :mimeType, nothing))
        data = get(value, "data", get(value, :data, nothing))
        if kind == "image" && mime_type isa AbstractString && data !== nothing
            return string(mime_type), string(data), true
        end
        return "application/json", senpi_json(value), false
    end
    value isa AbstractVector && return "application/json", senpi_json(value), false
    "text/plain", string(value), false
end

function display(value)
    mime_type, payload, encoded = senpi_display_payload(value)
    senpi_emit(Dict("type" => "display", "mimeType" => mime_type, "dataBase64" => encoded ? payload : senpi_base64(payload)))
    nothing
end

function display_image(base64_value::AbstractString, mime_type::AbstractString="image/png")
    senpi_emit(Dict("type" => "display", "mimeType" => string(mime_type), "dataBase64" => string(base64_value)))
    nothing
end

function text(value)
    senpi_emit(Dict("type" => "text", "stream" => "stdout", "data" => string(value)))
    nothing
end

function print(values...)
    text(join(string.(values), ""))
end

function read(path::AbstractString, offset::Integer=1, limit::Union{Integer, Nothing}=nothing)
    resolved = senpi_resolve_path(path)
    content = Base.read(resolved, String)
    if offset > 1 || limit !== nothing
        lines = split(content, '\n'; keepempty=true)
        start = max(1, Int(offset))
        finish = limit === nothing ? length(lines) : min(length(lines), start + Int(limit) - 1)
        content = start <= length(lines) ? join(lines[start:finish], '\n') : ""
    end
    senpi_emit_status("read", Dict("path" => resolved, "chars" => length(content), "preview" => first(content, min(length(content), 500))))
    content
end

function write(path::AbstractString, content)
    resolved = senpi_resolve_path(path)
    mkpath(dirname(resolved))
    data = string(content)
    open(resolved, "w") do io
        Base.write(io, data)
    end
    senpi_emit_status("write", Dict("path" => resolved, "chars" => length(data)))
    resolved
end

function env(key=nothing, value=nothing)
    if key === nothing
        values = Dict{String, String}(string(name) => string(item) for (name, item) in ENV)
        senpi_emit_status("env", Dict("count" => length(values), "keys" => sort(collect(keys(values)))[1:min(20, length(values))]))
        return values
    end
    name = string(key)
    if value === nothing
        resolved = get(ENV, name, nothing)
        senpi_emit_status("env", Dict("key" => name, "value" => resolved, "action" => "get"))
        return resolved
    end
    resolved = string(value)
    ENV[name] = resolved
    senpi_emit_status("env", Dict("key" => name, "value" => resolved, "action" => "set"))
    resolved
end

struct SenpiToolProxy end

struct SenpiToolCallable
    name::String
end

function (callable::SenpiToolCallable)(args=nothing; kwargs...)
    values = Dict{String, Any}()
    if args !== nothing
        args isa AbstractDict || error("tool.$(callable.name)(...) expects a dictionary of arguments")
        for (key, value) in args
            values[string(key)] = value
        end
    end
    for (key, value) in kwargs
        values[string(key)] = value
    end
    senpi_with_bridge_timeout_pause(() -> senpi_call_tool(callable.name, values))
end

Base.getproperty(::SenpiToolProxy, name::Symbol) = SenpiToolCallable(string(name))
const tool = SenpiToolProxy()

function completion(prompt::AbstractString; model="default", system=nothing, schema=nothing, kwargs...)
    options = Dict{String, Any}("model" => model)
    system !== nothing && (options["system"] = system)
    schema !== nothing && (options["schema"] = schema)
    for (key, value) in kwargs
        options[string(key)] = value
    end
    response = senpi_with_bridge_timeout_pause(() -> senpi_completion(string(prompt), options))
    response isa AbstractDict || return response
    haskey(response, "value") && return response["value"]
    get(response, "text", response)
end

function output(ids...; format="raw", offset=nothing, limit=nothing)
    isempty(ids) && error("At least one output ID is required")
    format in ("raw", "tail") || error("output() format must be 'raw' or 'tail'")
    arguments = Dict{String, Any}("ids" => string.(ids), "format" => format)
    offset !== nothing && (arguments["offset"] = offset)
    limit !== nothing && (arguments["limit"] = limit)
    senpi_with_bridge_timeout_pause(() -> senpi_call_tool("__output__", arguments))
end

function agent(prompt::AbstractString; agent="task", model=nothing, label=nothing, schema=nothing, isolated=nothing, apply=nothing, merge=nothing, handle=false, kwargs...)
    arguments = Dict{String, Any}("prompt" => string(prompt), "agent" => agent)
    for (key, value) in (("model", model), ("label", label), ("schema", schema), ("isolated", isolated), ("apply", apply), ("merge", merge))
        value !== nothing && (arguments[key] = value)
    end
    for (key, value) in kwargs
        arguments[string(key)] = value
    end
    handle && (arguments["handle"] = true)
    response = senpi_with_bridge_timeout_pause(() -> senpi_call_tool("__agent__", arguments))
    record = response isa AbstractDict ? response : Dict{String, Any}()
    text_value = get(record, "text", response)
    parsed = schema === nothing ? text_value : haskey(record, "data") ? record["data"] : senpi_json_parse(string(text_value))
    handle || return parsed
    result = Dict{String, Any}("text" => text_value, "output" => text_value, "id" => get(record, "id", nothing), "agent" => get(record, "agent", agent))
    result["handle"] = get(record, "handle", result["id"] === nothing ? nothing : "agent://" * string(result["id"]))
    schema !== nothing && (result["data"] = parsed)
    result
end

function senpi_pool_map(items, callback)
    values = collect(items)
    isempty(values) && return Any[]
    configured_width = get(senpi_connection, "parallelPoolWidth", 4)
    width = configured_width isa Real && isfinite(configured_width) ? Int(floor(configured_width)) : 4
    workers = min(max(width, 1), length(values))
    tokens = Channel{Nothing}(workers)
    for _ in 1:workers
        put!(tokens, nothing)
    end
    results = Vector{Any}(undef, length(values))
    errors = Dict{Int, Any}()
    lock = ReentrantLock()
    @sync for index in eachindex(values)
        @async begin
            take!(tokens)
            try
                results[index] = callback(values[index])
            catch error
                Base.lock(lock) do
                    errors[index] = error
                end
            finally
                put!(tokens, nothing)
            end
        end
    end
    isempty(errors) || throw(errors[minimum(keys(errors))])
    results
end

function parallel(thunks)
    values = collect(thunks)
    for thunk in values
        applicable(thunk) || error("parallel() expects zero-argument callables")
    end
    senpi_pool_map(values, thunk -> thunk())
end

function pipeline(items, stages...)
    values = collect(items)
    for stage in stages
        isempty(values) && return values
        applicable(stage, first(values)) || error("pipeline() stages must be callables")
        values = senpi_pool_map(values, stage)
    end
    values
end

function log(message)
    senpi_emit(Dict("type" => "log", "message" => string(message)))
    nothing
end

function phase(title)
    senpi_emit(Dict("type" => "phase", "title" => string(title)))
    nothing
end
