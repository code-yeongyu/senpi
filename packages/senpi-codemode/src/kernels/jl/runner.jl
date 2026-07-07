include("prelude.jl")

using Sockets

const senpi_connection = Dict{String, Any}()

function senpi_escape(text::AbstractString)
    # NOTE: prelude.jl defines Main-level `write`/`read` helpers for user cells,
    # which shadow Base within Main. Runner infrastructure must qualify Base calls
    # explicitly (Base.write/Base.read) or it crashes with a MethodError.
    out = IOBuffer()
    for c in text
        if c == '"'
            Base.write(out, "\\\"")
        elseif c == '\\'
            Base.write(out, "\\\\")
        elseif c == '\n'
            Base.write(out, "\\n")
        elseif c == '\r'
            Base.write(out, "\\r")
        elseif c == '\t'
            Base.write(out, "\\t")
        else
            Base.write(out, c)
        end
    end
    return String(take!(out))
end

function senpi_json(value)
    if value === nothing
        return "null"
    elseif value isa Bool
        return value ? "true" : "false"
    elseif value isa Number
        return string(value)
    elseif value isa AbstractString
        return "\"" * senpi_escape(value) * "\""
    elseif value isa AbstractDict
        pairs = ["\"" * senpi_escape(string(k)) * "\":" * senpi_json(v) for (k, v) in value]
        return "{" * join(pairs, ",") * "}"
    elseif value isa AbstractVector || value isa Tuple
        return "[" * join([senpi_json(v) for v in value], ",") * "]"
    else
        return "\"" * senpi_escape(string(value)) * "\""
    end
end

function senpi_parse_string(line::AbstractString, field::AbstractString)
    m = match(Regex("\"" * field * "\"\\s*:\\s*\"((?:\\\\.|[^\"])*)\""), line)
    m === nothing && return nothing
    return replace(m.captures[1], "\\n" => "\n", "\\\"" => "\"", "\\\\" => "\\")
end

function senpi_parse_bool(line::AbstractString, field::AbstractString)
    m = match(Regex("\"" * field * "\"\\s*:\\s*(true|false)"), line)
    m === nothing && return nothing
    return m.captures[1] == "true"
end

function senpi_parse_json_value(line::AbstractString)
    value = senpi_parse_string(line, "value")
    value !== nothing && return value
    m = match(r""""value"\s*:\s*(true|false)""", line)
    m !== nothing && return m.captures[1] == "true"
    m = match(r""""value"\s*:\s*(-?\d+(?:\.\d+)?)""", line)
    if m !== nothing
        text = m.captures[1]
        return occursin(".", text) ? parse(Float64, text) : parse(Int, text)
    end
    return nothing
end

function senpi_parse_error_message(line::AbstractString)
    message = senpi_parse_string(line, "message")
    return message === nothing ? line : message
end

function senpi_emit(frame)
    println(senpi_json(frame))
    flush(stdout)
end

function senpi_call_tool(name::String, args)
    if !haskey(senpi_connection, "port") || !haskey(senpi_connection, "token")
        error("Julia tool bridge is not initialized")
    end
    port = senpi_connection["port"]
    token = senpi_connection["token"]
    call_id = string(time_ns())
    body = senpi_json(Dict("callId" => call_id, "toolName" => name, "args" => args))
    socket = connect(ip"127.0.0.1", port)
    try
        request = join([
            "POST /call HTTP/1.1",
            "Host: 127.0.0.1",
            "Authorization: Bearer " * string(token),
            "Content-Type: application/json",
            "Content-Length: " * string(sizeof(body)),
            "Connection: close",
            "",
            body,
        ], "\r\n")
        Base.write(socket, request)
        flush(socket)
        response = Base.read(socket, String)
        parts = split(response, "\r\n\r\n"; limit=2)
        response_body = length(parts) == 2 ? parts[2] : response
        if senpi_parse_bool(response_body, "ok") == true
            return senpi_parse_json_value(response_body)
        end
        error(senpi_parse_error_message(response_body))
    finally
        close(socket)
    end
end

while !eof(stdin)
    line = readline(stdin)
    type = senpi_parse_string(line, "type")
    if type == "init"
        port_match = match(r""""port"\s*:\s*(\d+)""", line)
        token = senpi_parse_string(line, "token")
        if port_match !== nothing && token !== nothing
            senpi_connection["port"] = parse(Int, port_match.captures[1])
            senpi_connection["token"] = token
        end
        senpi_emit(Dict("type" => "ready"))
    elseif type == "run"
        cell_id = senpi_parse_string(line, "cellId")
        code = senpi_parse_string(line, "code")
        started = time()
        try
            value = Core.eval(Main, Meta.parse(code))
            frame = Dict("type" => "result", "cellId" => cell_id, "ok" => true, "durationMs" => round(Int, (time() - started) * 1000))
            if value !== nothing
                frame["valueRepr"] = senpi_json(value)
            end
            senpi_emit(frame)
        catch err
            senpi_emit(Dict("type" => "result", "cellId" => cell_id, "ok" => false, "error" => Dict("message" => string(err)), "durationMs" => round(Int, (time() - started) * 1000)))
        end
    elseif type == "close"
        senpi_emit(Dict("type" => "closed"))
        exit(0)
    end
end
