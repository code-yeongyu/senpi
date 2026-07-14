# allow: SIZE_OK — parser, stream capture, bridge calls, and the persistent execution loop share Main globals.
using Sockets

const SENPI_ORIGINAL_STDOUT = stdout
const SENPI_ORIGINAL_STDIN = stdin
out_read, out_write = redirect_stdout()
err_read, err_write = redirect_stderr()
redirect_stdin(devnull)

include("prelude.jl")

const senpi_connection = Dict{String, Any}()
const senpi_write_lock = ReentrantLock()
global senpi_current_cell = nothing

function senpi_escape(text::AbstractString)
    out = IOBuffer()
    for character in text
        if character == '"'
            Base.write(out, "\\\"")
        elseif character == '\\'
            Base.write(out, "\\\\")
        elseif character == '\n'
            Base.write(out, "\\n")
        elseif character == '\r'
            Base.write(out, "\\r")
        elseif character == '\t'
            Base.write(out, "\\t")
        else
            Base.write(out, character)
        end
    end
    String(take!(out))
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
        return "{" * join(["\"" * senpi_escape(string(key)) * "\":" * senpi_json(item) for (key, item) in value], ",") * "}"
    elseif value isa AbstractVector || value isa Tuple
        return "[" * join([senpi_json(item) for item in value], ",") * "]"
    end
    "\"" * senpi_escape(string(value)) * "\""
end

function senpi_json_parse(input::AbstractString)
    characters = collect(input)
    cursor = Ref(1)
    length_value = length(characters)
    function skip_space()
        while cursor[] <= length_value && isspace(characters[cursor[]])
            cursor[] += 1
        end
    end
    function parse_string()
        characters[cursor[]] == '"' || error("Expected JSON string")
        cursor[] += 1
        out = IOBuffer()
        while cursor[] <= length_value
            character = characters[cursor[]]
            cursor[] += 1
            character == '"' && return String(take!(out))
            if character != '\\'
                Base.write(out, character)
                continue
            end
            cursor[] <= length_value || error("Unexpected JSON string escape")
            escaped = characters[cursor[]]
            cursor[] += 1
            if escaped == 'u'
                cursor[] + 3 <= length_value || error("Incomplete JSON unicode escape")
                code = parse(Int, String(characters[cursor[]:cursor[] + 3]); base=16)
                Base.write(out, Char(code))
                cursor[] += 4
            else
                mapped = escaped == 'n' ? '\n' : escaped == 'r' ? '\r' : escaped == 't' ? '\t' : escaped == 'b' ? '\b' : escaped == 'f' ? '\f' : escaped
                Base.write(out, mapped)
            end
        end
        error("Unterminated JSON string")
    end
    function parse_value()
        skip_space()
        cursor[] <= length_value || error("Unexpected JSON end")
        character = characters[cursor[]]
        if character == '"'
            return parse_string()
        elseif character == '{'
            cursor[] += 1
            object_result = Dict{String, Any}()
            skip_space()
            if cursor[] <= length_value && characters[cursor[]] == '}'
                cursor[] += 1
                return object_result
            end
            while true
                skip_space()
                key = parse_string()
                skip_space()
                cursor[] <= length_value && characters[cursor[]] == ':' || error("Expected JSON object colon")
                cursor[] += 1
                object_result[key] = parse_value()
                skip_space()
                cursor[] <= length_value || error("Unexpected JSON object end")
                characters[cursor[]] == '}' && (cursor[] += 1; return object_result)
                characters[cursor[]] == ',' || error("Expected JSON object separator")
                cursor[] += 1
            end
        elseif character == '['
            cursor[] += 1
            array_result = Any[]
            skip_space()
            if cursor[] <= length_value && characters[cursor[]] == ']'
                cursor[] += 1
                return array_result
            end
            while true
                push!(array_result, parse_value())
                skip_space()
                cursor[] <= length_value || error("Unexpected JSON array end")
                characters[cursor[]] == ']' && (cursor[] += 1; return array_result)
                characters[cursor[]] == ',' || error("Expected JSON array separator")
                cursor[] += 1
            end
        elseif startswith(String(characters[cursor[]:end]), "true")
            cursor[] += 4
            return true
        elseif startswith(String(characters[cursor[]:end]), "false")
            cursor[] += 5
            return false
        elseif startswith(String(characters[cursor[]:end]), "null")
            cursor[] += 4
            return nothing
        end
        start = cursor[]
        while cursor[] <= length_value && characters[cursor[]] in ['-', '+', '.', 'e', 'E', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9']
            cursor[] += 1
        end
        number = String(characters[start:cursor[] - 1])
        integer = tryparse(Int, number)
        integer === nothing || return integer
        decimal = tryparse(Float64, number)
        decimal === nothing && error("Invalid JSON value")
        decimal
    end
    parsed_result = parse_value()
    skip_space()
    cursor[] > length_value || error("Trailing JSON data")
    parsed_result
end

function senpi_emit(frame)
    lock(senpi_write_lock) do
        println(SENPI_ORIGINAL_STDOUT, senpi_json(frame))
        flush(SENPI_ORIGINAL_STDOUT)
    end
    nothing
end

function senpi_emit_stream(stream::String, bytes::Vector{UInt8})
    senpi_current_cell === nothing && return nothing
    isempty(bytes) && return nothing
    data = try
        String(copy(bytes))
    catch
        repr(bytes)
    end
    senpi_emit(Dict("type" => "text", "stream" => stream, "data" => data))
    nothing
end

function senpi_drain_stream(io, stream::String)
    while true
        bytes = readavailable(io)
        if !isempty(bytes)
            senpi_emit_stream(stream, bytes)
        elseif eof(io)
            return nothing
        else
            yield()
            sleep(0.001)
        end
    end
end

@async senpi_drain_stream(out_read, "stdout")
@async senpi_drain_stream(err_read, "stderr")

function senpi_http_body(response::AbstractString)
    parts = split(response, "\r\n\r\n"; limit=2)
    length(parts) == 2 || return response
    headers, body = parts
    occursin("transfer-encoding: chunked", lowercase(headers)) || return body
    bytes = collect(codeunits(body))
    output = UInt8[]
    cursor = 1
    while cursor <= length(bytes)
        header_end = nothing
        for index in cursor:length(bytes) - 1
            if bytes[index] == 0x0d && bytes[index + 1] == 0x0a
                header_end = index
                break
            end
        end
        header_end === nothing && error("Invalid chunked bridge response")
        chunk_size = parse(Int, split(String(bytes[cursor:header_end - 1]), ";"; limit=2)[1]; base=16)
        cursor = header_end + 2
        chunk_size == 0 && break
        cursor + chunk_size - 1 <= length(bytes) || error("Truncated chunked bridge response")
        append!(output, bytes[cursor:cursor + chunk_size - 1])
        cursor += chunk_size + 2
    end
    String(output)
end

function senpi_bridge_request(path::String, payload)
    port = get(senpi_connection, "port", nothing)
    token = get(senpi_connection, "token", nothing)
    port isa Integer && token isa AbstractString || error("Julia tool bridge is not initialized")
    body = senpi_json(payload)
    socket = connect(ip"127.0.0.1", port)
    try
        request = join([
            "POST " * path * " HTTP/1.1",
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
        parsed = senpi_json_parse(senpi_http_body(response))
        parsed isa AbstractDict || error("Bridge returned invalid JSON")
        get(parsed, "ok", false) === true && return get(parsed, "value", nothing)
        failure = get(parsed, "error", parsed)
        error(failure isa AbstractDict ? string(get(failure, "message", failure)) : string(failure))
    finally
        close(socket)
    end
end

function senpi_call_tool(name::String, arguments)
    senpi_bridge_request("/call", Dict("callId" => "jl-" * string(time_ns()), "toolName" => name, "args" => arguments))
end

function senpi_completion(prompt::String, options)
    senpi_bridge_request("/completion", Dict("prompt" => prompt, "opts" => options))
end

function senpi_error(error)
    message = sprint(showerror, error)
    Dict("name" => string(typeof(error)), "message" => message)
end

function senpi_should_display_result(parsed)
    if parsed isa Expr && parsed.head === :block && !isempty(parsed.args)
        last = parsed.args[end]
        if last isa Expr && last.head in [Symbol("="), :function, :struct, :using, :import, :const, :global, :local, :macro]
            return false
        end
    end
    true
end

function senpi_set_connection(value)
    value isa AbstractDict || error("missing bridge connection")
    empty!(senpi_connection)
    for (key, item) in value
        senpi_connection[string(key)] = item
    end
end

function senpi_run_cell(message)
    cell_id = string(get(message, "cellId", ""))
    code = string(get(message, "code", ""))
    started = time()
    global senpi_current_cell = cell_id
    try
        parsed = Meta.parse("begin\n" * code * "\nend")
        if parsed isa Expr && parsed.head === :error
            error(string(parsed.args[1]))
        end
        value = Core.eval(Main, parsed)
        flush(stdout)
        flush(stderr)
        yield()
        frame = Dict{String, Any}("type" => "result", "cellId" => cell_id, "ok" => true, "durationMs" => round(Int, (time() - started) * 1000))
        value !== nothing && senpi_should_display_result(parsed) && (frame["valueRepr"] = senpi_json(value))
        senpi_emit(frame)
    catch error
        senpi_emit(Dict("type" => "result", "cellId" => cell_id, "ok" => false, "error" => senpi_error(error), "durationMs" => round(Int, (time() - started) * 1000)))
    finally
        global senpi_current_cell = nothing
    end
end

while !eof(SENPI_ORIGINAL_STDIN)
    line = readline(SENPI_ORIGINAL_STDIN)
    isempty(line) && continue
    try
        message = senpi_json_parse(line)
        message isa AbstractDict || error("Bridge frame must be an object")
        kind = get(message, "type", nothing)
        if kind == "init"
            senpi_set_connection(get(message, "connection", nothing))
            senpi_emit(Dict("type" => "ready"))
        elseif kind == "run"
            senpi_run_cell(message)
        elseif kind == "close"
            senpi_emit(Dict("type" => "closed"))
            break
        end
    catch error
        senpi_emit(Dict("type" => "init-failed", "error" => senpi_error(error)))
    end
end
