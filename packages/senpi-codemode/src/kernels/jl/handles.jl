# In-cell wait()/handle() over the host's handle capability. Mirrors src/bridge/reserved.ts.
# `Main.wait` is never defined here: `Base.wait` gains methods for the handle types, so `wait(::Task)` for
# `@async` users keeps working.
const SENPI_RESERVED_WAIT_TOOL = "__wait__"
const SENPI_RESERVED_HANDLE_STATUS_TOOL = "__handle_status__"
const SENPI_RESERVED_HANDLE_OUTPUT_TOOL = "__handle_output__"
const SENPI_RESERVED_HANDLE_SEND_TOOL = "__handle_send__"
const SENPI_RESERVED_HANDLE_CANCEL_TOOL = "__handle_cancel__"
const SENPI_HANDLE_KINDS = ("agent", "completion", "workpool")
const SENPI_WAIT_MODES = ("all", "any", "settled")
const SENPI_WAIT_SOCKET_GRACE_SECONDS = 30
const SENPI_HANDLE_USAGE = "handle() expects an agent(...; handle=true) record, a workpool, a completion handle, or a saved {kind, id, run_epoch} reference"

struct SenpiHandleControl
    ref::Dict{String, Any}
end

# The legacy record's fields behave as a Dict; `control` and `ref` are properties, never keys.
struct SenpiHandle <: AbstractDict{String, Any}
    fields::Dict{String, Any}
    ref::Dict{String, Any}
end

Base.iterate(handle::SenpiHandle, state...) = iterate(getfield(handle, :fields), state...)
Base.length(handle::SenpiHandle) = length(getfield(handle, :fields))
Base.get(handle::SenpiHandle, key, default) = get(getfield(handle, :fields), key, default)
Base.getindex(handle::SenpiHandle, key) = getfield(handle, :fields)[key]
Base.haskey(handle::SenpiHandle, key) = haskey(getfield(handle, :fields), key)
Base.keys(handle::SenpiHandle) = keys(getfield(handle, :fields))
Base.values(handle::SenpiHandle) = values(getfield(handle, :fields))

function Base.getproperty(handle::SenpiHandle, name::Symbol)
    name === :ref && return copy(getfield(handle, :ref))
    name === :control && return SenpiHandleControl(copy(getfield(handle, :ref)))
    fields = getfield(handle, :fields)
    key = string(name)
    haskey(fields, key) && return fields[key]
    getfield(handle, name)
end

Base.propertynames(handle::SenpiHandle) = (Symbol.(collect(keys(getfield(handle, :fields))))..., :control, :ref)

function senpi_handle_ref(value)
    value isa SenpiHandle && return copy(getfield(value, :ref))
    value isa SenpiWorkpool && return Dict{String, Any}("kind" => "workpool", "id" => getfield(value, :pool_id), "run_epoch" => 0)
    value isa AbstractDict || error(SENPI_HANDLE_USAGE)
    record = Dict{String, Any}(string(key) => item for (key, item) in value)
    pool_id = get(record, "pool_id", nothing)
    pool_id isa AbstractString && return Dict{String, Any}("kind" => "workpool", "id" => string(pool_id), "run_epoch" => 0)
    kind = get(record, "kind", nothing)
    if !(kind in SENPI_HANDLE_KINDS)
        handle_uri = get(record, "handle", nothing)
        scheme = handle_uri isa AbstractString ? first(split(handle_uri, "://"; limit=2)) : nothing
        kind = scheme in SENPI_HANDLE_KINDS ? scheme : nothing
    end
    identity = get(record, "id", get(record, "task_id", nothing))
    (kind === nothing || !(identity isa AbstractString) || isempty(identity)) && error(SENPI_HANDLE_USAGE)
    run_epoch = get(record, "run_epoch", kind == "workpool" ? 0 : nothing)
    (run_epoch isa Integer && !(run_epoch isa Bool) && run_epoch >= 0) || error(SENPI_HANDLE_USAGE * "; run_epoch must be a non-negative integer")
    Dict{String, Any}("kind" => string(kind), "id" => string(identity), "run_epoch" => Int(run_epoch))
end

function senpi_handle_call(tool_name::String, arguments)
    senpi_with_bridge_timeout_pause(() -> senpi_call_tool(tool_name, arguments))
end

# A long-lived request bounded by the explicit timeout (plus grace for the host's reply) or else only by the
# cell's own end; an interrupt from the host (cancel, the cell's hard limit) closes the socket and so the
# host-side subscription.
function senpi_wait_post(arguments, timeout)
    read_timeout = timeout === nothing ? nothing : Float64(timeout) + SENPI_WAIT_SOCKET_GRACE_SECONDS
    payload = Dict("callId" => "jl-" * string(time_ns()), "toolName" => SENPI_RESERVED_WAIT_TOOL, "args" => arguments)
    senpi_with_bridge_timeout_pause(() -> senpi_bridge_request("/call", payload; read_timeout=read_timeout))
end

function senpi_wait(handles; timeout=nothing, mode="all")
    items = handles === nothing ? Any[] : handles isa AbstractVector || handles isa Tuple ? collect(handles) : Any[handles]
    if timeout !== nothing
        (timeout isa Real && !(timeout isa Bool) && isfinite(timeout) && timeout >= 0) || error("wait() timeout must be a finite number of seconds >= 0")
    end
    string(mode) in SENPI_WAIT_MODES || error("wait() mode must be \"all\", \"any\" or \"settled\"")
    arguments = Dict{String, Any}("refs" => [senpi_handle_ref(item) for item in items], "mode" => string(mode))
    timeout === nothing || (arguments["timeout"] = timeout)
    senpi_wait_post(arguments, timeout)
end

function Base.getproperty(control::SenpiHandleControl, name::Symbol)
    ref = getfield(control, :ref)
    name === :ref && return copy(ref)
    name === :status && return () -> senpi_handle_call(SENPI_RESERVED_HANDLE_STATUS_TOOL, Dict("ref" => ref))
    if name === :output
        return (; format="raw", offset=nothing, limit=nothing) -> begin
            arguments = Dict{String, Any}("ref" => ref, "format" => string(format))
            offset === nothing || (arguments["offset"] = offset)
            limit === nothing || (arguments["limit"] = limit)
            senpi_handle_call(SENPI_RESERVED_HANDLE_OUTPUT_TOOL, arguments)
        end
    end
    name === :send && return message -> senpi_handle_call(SENPI_RESERVED_HANDLE_SEND_TOOL, Dict("ref" => ref, "message" => string(message)))
    name === :cancel && return () -> senpi_handle_call(SENPI_RESERVED_HANDLE_CANCEL_TOOL, Dict("ref" => ref))
    name === :wait && return (; timeout=nothing) -> senpi_wait([ref]; timeout=timeout, mode="all")[1]
    getfield(control, name)
end

Base.propertynames(::SenpiHandleControl) = (:status, :output, :send, :cancel, :wait, :ref)
Base.show(io::IO, control::SenpiHandleControl) = Base.print(io, "<handle.control ", getfield(control, :ref)["kind"], "://", getfield(control, :ref)["id"], "@", getfield(control, :ref)["run_epoch"], ">")

function senpi_handle_view(value)
    ref = senpi_handle_ref(value)
    fields = Dict{String, Any}()
    if value isa AbstractDict
        for (key, item) in value
            item isa Function || (fields[string(key)] = item)
        end
    end
    get!(fields, "id", ref["id"])
    get!(fields, "run_epoch", ref["run_epoch"])
    get!(fields, "handle", ref["kind"] * "://" * ref["id"])
    SenpiHandle(fields, ref)
end

# Block until the handles settle; never cancels work. See tool_schema("eval:wait").
Base.wait(handle::SenpiHandle; timeout=nothing, mode="all") = senpi_wait([handle]; timeout=timeout, mode=mode)
Base.wait(handles::AbstractVector{<:SenpiHandle}; timeout=nothing, mode="all") = senpi_wait(handles; timeout=timeout, mode=mode)
