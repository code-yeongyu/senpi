# In-cell wait()/handle() over the host's handle capability. Mirrors src/bridge/reserved.ts.
SENPI_RESERVED_WAIT_TOOL = "__wait__"
SENPI_RESERVED_HANDLE_STATUS_TOOL = "__handle_status__"
SENPI_RESERVED_HANDLE_OUTPUT_TOOL = "__handle_output__"
SENPI_RESERVED_HANDLE_SEND_TOOL = "__handle_send__"
SENPI_RESERVED_HANDLE_CANCEL_TOOL = "__handle_cancel__"
SENPI_HANDLE_KINDS = ["agent", "completion", "workpool"].freeze
SENPI_WAIT_MODES = ["all", "any", "settled"].freeze
SENPI_WAIT_SOCKET_GRACE_SECONDS = 30
SENPI_HANDLE_USAGE = "handle() expects an agent(..., handle: true) record, a workpool, a completion handle, or a saved {kind, id, run_epoch} reference"

def __senpi_handle_ref(value)
  return value.ref.dup if value.respond_to?(:ref) && value.respond_to?(:control)
  return { "kind" => "workpool", "id" => value.pool_id, "run_epoch" => 0 } if value.is_a?(SenpiWorkpool)
  raise TypeError, SENPI_HANDLE_USAGE unless value.is_a?(Hash)
  record = value.transform_keys(&:to_s)
  return { "kind" => "workpool", "id" => record["pool_id"], "run_epoch" => 0 } if record["pool_id"].is_a?(String)
  kind = record["kind"]
  unless SENPI_HANDLE_KINDS.include?(kind)
    scheme = record["handle"].is_a?(String) ? record["handle"].split("://", 2).first : nil
    kind = SENPI_HANDLE_KINDS.include?(scheme) ? scheme : nil
  end
  identity = record.fetch("id", record["task_id"])
  raise TypeError, SENPI_HANDLE_USAGE if kind.nil? || !identity.is_a?(String) || identity.empty?
  run_epoch = record.fetch("run_epoch", kind == "workpool" ? 0 : nil)
  raise TypeError, "#{SENPI_HANDLE_USAGE}; run_epoch must be a non-negative integer" unless run_epoch.is_a?(Integer) && run_epoch >= 0
  { "kind" => kind, "id" => identity, "run_epoch" => run_epoch }
end

# A long-lived request: ordinary calls keep their 60 s read timeout; this one is bounded by the explicit
# timeout (plus grace for the host's reply) or else only by the cell's own end: SIGINT from the host (cancel,
# the cell's hard limit) interrupts the read, which closes the socket and the host-side subscription.
def __senpi_wait_post(args, timeout)
  read_timeout = timeout.nil? ? nil : timeout.to_f + SENPI_WAIT_SOCKET_GRACE_SECONDS
  payload = { "callId" => "rb-#{Process.pid}-#{rand(1_000_000)}", "toolName" => SENPI_RESERVED_WAIT_TOOL, "args" => args }
  __senpi_bridge_request("/call", payload, read_timeout: read_timeout)
end

def __senpi_wait(handles, timeout: nil, mode: "all")
  items = handles.nil? ? [] : handles.is_a?(Array) ? handles : [handles]
  unless timeout.nil? || (timeout.is_a?(Numeric) && timeout.to_f.finite? && timeout >= 0)
    raise ArgumentError, "wait() timeout must be a finite number of seconds >= 0"
  end
  raise ArgumentError, "wait() mode must be 'all', 'any' or 'settled'" unless SENPI_WAIT_MODES.include?(mode.to_s)
  args = { "refs" => items.map { |item| __senpi_handle_ref(item) }, "mode" => mode.to_s }
  args["timeout"] = timeout unless timeout.nil?
  __senpi_wait_post(args, timeout)
end

class SenpiHandleControl
  def initialize(ref)
    @ref = ref.dup.freeze
    freeze
  end

  def status
    __senpi_call_tool(SENPI_RESERVED_HANDLE_STATUS_TOOL, { "ref" => @ref })
  end

  def output(format: "raw", offset: nil, limit: nil)
    args = { "ref" => @ref, "format" => format }
    args["offset"] = offset unless offset.nil?
    args["limit"] = limit unless limit.nil?
    __senpi_call_tool(SENPI_RESERVED_HANDLE_OUTPUT_TOOL, args)
  end

  def send_message(message)
    __senpi_call_tool(SENPI_RESERVED_HANDLE_SEND_TOOL, { "ref" => @ref, "message" => message.to_s })
  end
  # Deliberately shadows Object#send so control.send(msg) matches the other languages; use __send__ for reflection.
  alias send send_message

  def cancel
    __senpi_call_tool(SENPI_RESERVED_HANDLE_CANCEL_TOOL, { "ref" => @ref })
  end

  def wait(timeout: nil)
    __senpi_wait([@ref], timeout: timeout, mode: "all")[0]
  end

  def inspect
    "#<handle.control #{@ref["kind"]}://#{@ref["id"]}@#{@ref["run_epoch"]}>"
  end
end

# The legacy record's fields as a Hash copy; `control` and `ref` are singleton methods, never keys.
def __senpi_handle_view(value)
  ref = __senpi_handle_ref(value)
  view = value.is_a?(Hash) ? value.transform_keys(&:to_s).reject { |_key, item| item.respond_to?(:call) } : {}
  view["id"] ||= ref["id"]
  view["run_epoch"] ||= ref["run_epoch"]
  view["handle"] ||= "#{ref["kind"]}://#{ref["id"]}"
  control = SenpiHandleControl.new(ref)
  view.define_singleton_method(:control) { control }
  view.define_singleton_method(:ref) { ref.dup }
  view
end
