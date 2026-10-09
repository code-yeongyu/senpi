# Only an opaque host identity is retained; all work remains engine-owned.
def __senpi_workpool_call(args)
  tool.workpool(args)
rescue SenpiBridgeError => error
  raise SenpiBridgeError.new("No active host workpool tool", "workpool_unavailable") if ["unknown_tool", "inactive_tool"].include?(error.code)
  raise
end

class SenpiWorkpool
  attr_reader :pool_id

  def initialize(pool_id)
    @pool_id = pool_id
    freeze
  end

  def push(items)
    __senpi_workpool_call({ "op" => "push", "pool_id" => @pool_id, "items" => items })
  end

  [:close, :inspect, :cancel].each do |op|
    define_method(op) { __senpi_workpool_call({ "op" => op.to_s, "pool_id" => @pool_id }) }
  end
end

def workpool(agent, name, mode: nil, tools: nil)
  args = { "op" => "create", "agent" => agent, "name" => name }
  args["mode"] = mode unless mode.nil?
  unless tools.nil?
    unless tools.is_a?(Array) && tools.all? { |name| name.is_a?(String) }
      raise SenpiBridgeError.new("workpool(tools: ...) takes an array of tool names; got #{tools.class}", "invalid_tools")
    end
    args["tools"] = tools.dup
  end
  result = __senpi_workpool_call(args)
  details = result["details"]
  if details.is_a?(Hash)
    error = details["error"]
    raise SenpiBridgeError.new(error["message"], error["code"]) if error.is_a?(Hash)
    pool_id = details["pool_id"]
    return SenpiWorkpool.new(pool_id) if !result["hasError"] && pool_id.is_a?(String) && /\Awp_[0-9a-f]{32}\z/.match?(pool_id)
  end
  raise SenpiBridgeError.new("Host did not return a workpool identity", "workpool_unavailable")
end
