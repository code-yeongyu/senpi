# NOTE: deliberately NO `using Base64`. On a cold Julia depot (a fresh CI runner
# home) the first `using Base64` triggers a serial package precompile (~1s+ of CPU
# and disk IO); under an oversubscribed CI runner that spike balloons past the
# per-cell timeout, so the kernel's first cell would flakily time out, restart, and
# lose session state. Every other kernel dependency (Sockets in runner.jl, Base) is
# already in the shipped sysimage and needs no precompile, so base64 is the only
# precompile trigger — we hand-roll it against Base to keep cold start deterministic.
# Verified byte-exact against Base64.base64encode (empty / 1-2-3 byte remainders /
# multibyte UTF-8 / binary / long input).
const SENPI_B64_ALPHABET = collect("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/")

function senpi_base64(text::AbstractString)
    # prelude.jl shadows Base `write` within Main, so infrastructure must qualify
    # Base.write explicitly (see the same policy note in runner.jl).
    bytes = codeunits(text)
    out = IOBuffer()
    n = length(bytes)
    i = 1
    while i <= n
        b0 = bytes[i]
        b1 = i + 1 <= n ? bytes[i + 1] : UInt8(0)
        b2 = i + 2 <= n ? bytes[i + 2] : UInt8(0)
        Base.write(out, SENPI_B64_ALPHABET[(b0 >> 2) + 1])
        Base.write(out, SENPI_B64_ALPHABET[(((b0 & 0x03) << 4) | (b1 >> 4)) + 1])
        Base.write(out, i + 1 <= n ? SENPI_B64_ALPHABET[(((b1 & 0x0f) << 2) | (b2 >> 6)) + 1] : '=')
        Base.write(out, i + 2 <= n ? SENPI_B64_ALPHABET[(b2 & 0x3f) + 1] : '=')
        i += 3
    end
    return String(take!(out))
end

function display(value)
    text = senpi_json(value)
    senpi_emit(Dict("type" => "display", "mimeType" => "application/json", "dataBase64" => senpi_base64(text)))
    return nothing
end

function print(values...)
    senpi_emit(Dict("type" => "text", "stream" => "stdout", "data" => join(string.(values), "")))
    return nothing
end

function read(path::AbstractString)
    return Base.read(path, String)
end

function write(path::AbstractString, content)
    Base.write(path, string(content))
    return path
end

function env(key=nothing, value=nothing)
    if key === nothing
        return Dict(k => v for (k, v) in ENV)
    elseif value === nothing
        return get(ENV, string(key), nothing)
    else
        ENV[string(key)] = string(value)
        return value
    end
end

function log(message)
    senpi_emit(Dict("type" => "log", "message" => string(message)))
    return nothing
end

function phase(title)
    senpi_emit(Dict("type" => "phase", "title" => string(title)))
    return nothing
end

struct SenpiToolProxy end

function Base.getproperty(::SenpiToolProxy, name::Symbol)
    return args -> senpi_call_tool(string(name), args)
end

const tool = SenpiToolProxy()
