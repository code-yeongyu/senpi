# allow: SIZE_OK — parser, stream capture, bridge calls, and the persistent execution loop share Main globals.
write(stdout, "{\"type\":\"status\",\"event\":{\"op\":\"kernel-startup\",\"stage\":\"stdlib-imports\"}}\n")
flush(stdout)
using Sockets

const SENPI_ORIGINAL_STDOUT = stdout
const SENPI_ORIGINAL_STDIN = stdin
out_read, out_write = redirect_stdout()
err_read, err_write = redirect_stderr()
redirect_stdin(devnull)

write(SENPI_ORIGINAL_STDOUT, "{\"type\":\"status\",\"event\":{\"op\":\"kernel-startup\",\"stage\":\"runtime-init\"}}\n")
flush(SENPI_ORIGINAL_STDOUT)
include("prelude.jl")

const senpi_connection = Dict{String, Any}()
const senpi_write_lock = ReentrantLock()
global senpi_current_cell = nothing
global senpi_memory_cell = nothing

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

# `read_timeout` (seconds) bounds only the long-lived `wait()` request; ordinary calls read until the host closes.
function senpi_bridge_request(path::String, payload; read_timeout=nothing)
    port = get(senpi_connection, "port", nothing)
    token = get(senpi_connection, "token", nothing)
    port isa Integer && token isa AbstractString || error("Julia tool bridge is not initialized")
    body = senpi_json(payload)
    socket = connect(ip"127.0.0.1", port)
    timed_out = Ref(false)
    timer = read_timeout === nothing ? nothing : Timer(_ -> (timed_out[] = true; close(socket)), Float64(read_timeout))
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
        timed_out[] && throw(SenpiBridgeError("bridge request timed out after $(read_timeout)s", "bridge_timeout"))
        parsed = senpi_json_parse(senpi_http_body(response))
        parsed isa AbstractDict || error("Bridge returned invalid JSON")
        get(parsed, "ok", false) === true && return get(parsed, "value", nothing)
        failure = get(parsed, "error", parsed)
        throw(SenpiBridgeError(failure isa AbstractDict ? string(get(failure, "message", failure)) : string(failure), failure isa AbstractDict ? get(failure, "code", nothing) : nothing))
    finally
        timer === nothing || close(timer)
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

const SENPI_MEMORY_INTERNALS = Set([:senpi_current_cell, :senpi_connection, :senpi_frame_io, :senpi_stdout_capture, :senpi_stderr_capture, :senpi_protocol_stdin])

const SENPI_SIZER_SAMPLE = 1_000
const SENPI_SIZER_NODE_BUDGET = 5_000
const SENPI_SIZER_MAX_DEPTH = 64
const SENPI_SIZER_POINTER = 8
const SENPI_SIZER_OBJECT = 16
const SENPI_SIZER_MIN_REPORTED = 1024 * 1024

# Sizes a global with sampling and a node budget per global (leaves count too), so one deep global
# never hides the ones measured after it and a huge container costs a bounded walk. Only concrete Base
# containers are iterated; any other AbstractDict or AbstractSet is sized as an opaque struct, so no user
# length or iterate method runs during a memory report.
mutable struct SenpiSizer
    seen::IdDict{Any, Nothing}
    nodes::Int
    approximate::Bool
end
SenpiSizer() = SenpiSizer(IdDict{Any, Nothing}(), 0, false)

senpi_over_budget(sizer::SenpiSizer) = sizer.nodes >= SENPI_SIZER_NODE_BUDGET

function senpi_size(sizer::SenpiSizer, value, depth::Int)::Int
    sizer.nodes += 1
    value isa Type && return 0
    value isa Union{Number, Char, Bool, Symbol, Nothing} && return isbits(value) ? sizeof(value) : 0
    value isa String && return SENPI_SIZER_OBJECT + sizeof(value)
    if ismutable(value)
        haskey(sizer.seen, value) && return 0
        sizer.seen[value] = nothing
    end
    if depth >= SENPI_SIZER_MAX_DEPTH || senpi_over_budget(sizer)
        sizer.approximate = true
        return SENPI_SIZER_OBJECT
    end
    if value isa Array
        isbitstype(eltype(value)) && return SENPI_SIZER_OBJECT + sizeof(value)
        return SENPI_SIZER_OBJECT + length(value) * SENPI_SIZER_POINTER +
            senpi_sampled(sizer, length(value), depth) do index
                isassigned(value, index) ? value[index] : nothing
            end
    elseif value isa Union{Dict, IdDict}
        count = length(value)
        total = 0
        taken = 0
        for (key, item) in value
            senpi_over_budget(sizer) && break
            total += senpi_size(sizer, key, depth + 1) + senpi_size(sizer, item, depth + 1)
            taken += 1
            taken >= SENPI_SIZER_SAMPLE && break
        end
        taken < count && (sizer.approximate = true)
        return SENPI_SIZER_OBJECT + count * 2 * SENPI_SIZER_POINTER + (taken == 0 ? 0 : div(total * count, taken))
    elseif value isa Union{Set, Tuple}
        count = length(value)
        total = 0
        taken = 0
        for item in value
            senpi_over_budget(sizer) && break
            total += senpi_size(sizer, item, depth + 1)
            taken += 1
            taken >= SENPI_SIZER_SAMPLE && break
        end
        taken < count && (sizer.approximate = true)
        return SENPI_SIZER_OBJECT + count * SENPI_SIZER_POINTER + (taken == 0 ? 0 : div(total * count, taken))
    end
    isbits(value) && return sizeof(value)
    fields = fieldcount(typeof(value))
    return SENPI_SIZER_OBJECT + fields * SENPI_SIZER_POINTER +
        senpi_sampled(sizer, fields, depth) do index
            isdefined(value, index) ? getfield(value, index) : nothing
        end
end

# Up to SENPI_SIZER_SAMPLE evenly spaced elements; once the budget runs out part-way, the elements measured
# so far stand in for the rest.
function senpi_sampled(at, sizer::SenpiSizer, count::Int, depth::Int)::Int
    count == 0 && return 0
    picks = min(count, SENPI_SIZER_SAMPLE)
    picks < count && (sizer.approximate = true)
    step = count / picks
    total = 0
    measured = 0
    for sample in 1:picks
        if senpi_over_budget(sizer)
            sizer.approximate = true
            break
        end
        total += senpi_size(sizer, at(1 + floor(Int, (sample - 1) * step)), depth + 1)
        measured += 1
    end
    return measured == 0 ? 0 : round(Int, total / measured * count)
end

function senpi_largest_globals(limit::Int)
    try
        sizer = SenpiSizer()
        candidates = Tuple{String, Int, Bool}[]
        Base.invokelatest() do
            for name in names(Main, all = true)
                name in SENPI_MEMORY_INTERNALS && continue
                name in (:Main, :Base, :Core, :Ans, :ans) && continue
                lowered = lowercase(string(name))
                startswith(lowered, "senpi_") && continue
                startswith(string(name), "Senpi") && continue
                startswith(string(name), "#") && continue
                isdefined(Main, name) || continue
                value = getfield(Main, name)
                value isa Module && continue
                value isa IO && continue
                value isa Type && continue
                value isa Function && continue
                sizer.approximate = false
                sizer.nodes = 0
                bytes = try
                    senpi_size(sizer, value, 0) + SENPI_SIZER_POINTER
                catch
                    0
                end
                bytes >= SENPI_SIZER_MIN_REPORTED && push!(candidates, (string(name), bytes, sizer.approximate))
            end
        end
        sort!(candidates, by = entry -> entry[2], rev = true)
        [approximate ? Dict{String, Any}("name" => name, "bytes" => bytes, "approximate" => true) : Dict{String, Any}("name" => name, "bytes" => bytes) for (name, bytes, approximate) in candidates[1:min(limit, end)]]
    catch
        Dict{String, Any}[]
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
        global senpi_memory_cell = cell_id
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
            senpi_emit(Dict("type" => "status", "event" => Dict("op" => "kernel-startup", "stage" => "host-init")))
            senpi_set_connection(get(message, "connection", nothing))
            senpi_emit(Dict("type" => "ready", "memoryGlobals" => true))
        elseif kind == "run"
            global senpi_memory_cell = nothing
            senpi_run_cell(message)
        elseif kind == "memory-globals"
            cell_id = get(message, "cellId", nothing)
            if cell_id == senpi_memory_cell && senpi_current_cell === nothing
                senpi_emit(Dict("type" => "memory-globals-result", "cellId" => cell_id, "globals" => senpi_largest_globals(5)))
                global senpi_memory_cell = nothing
            end
        elseif kind == "close"
            senpi_emit(Dict("type" => "closed"))
            break
        end
    catch error
        senpi_emit(Dict("type" => "init-failed", "error" => senpi_error(error)))
    end
end
