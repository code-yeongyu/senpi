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
