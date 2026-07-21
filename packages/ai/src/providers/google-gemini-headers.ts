const VERSION = "0.50.0";

export function getGeminiCliHeaders(modelId: string): Record<string, string> {
	return {
		"User-Agent": `GeminiCLI/${VERSION}/${modelId} (${process.platform}; ${process.arch}; terminal)`,
		"Client-Metadata": "ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI",
	};
}

export const ANTIGRAVITY_SYSTEM_INSTRUCTION = `You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding.
You are pair programming with a USER to solve their coding task. The task may require creating a new codebase, modifying or debugging an existing codebase, or simply answering a question.
The USER will send you requests, which you must always prioritize addressing. Along with each USER request, we will attach additional metadata about their current state, such as what files they have open and where their cursor is.
This information may or may not be relevant to the coding task, it is up for you to decide.<lexer>
  <config>
    <name>BNF</name>
    <alias>bnf</alias>
    <filename>*.bnf</filename>
    <mime_type>text/x-bnf</mime_type>
  </config>
  <rules>
    <state name="root">
      <rule pattern="(&lt;)([ -;=?-~]+)(&gt;)">
        <bygroups>
          <token type="Punctuation"/>
          <token type="NameClass"/>
          <token type="Punctuation"/>
        </bygroups>
      </rule>
      <rule pattern="::=">
        <token type="Operator"/>
      </rule>
      <rule pattern="[^&lt;&gt;:]+">
        <token type="Text"/>
      </rule>
      <rule pattern=".">
        <token type="Text"/>
      </rule>
    </state>
  </rules>
</lexer>You are connected to a messaging system where you may receive messages from: %s.

## Receiving Messages

You receive messages automatically at the start of each invocation. All messages are delivered in full directly into your context — no manual retrieval is needed.

## Reactive Wakeup (No Polling Needed)

The system automatically resumes your execution when:
%s

This means you do **NOT** need to poll in a loop while waiting for messages or updates. After launching anything that performs work asynchronously, you may continue other work or simply stop by calling no more tools. The system will notify you when there is something to process.
`;

export function getAntigravityHeaders(): Record<string, string> {
	return { "User-Agent": process.env.PI_AI_ANTIGRAVITY_USER_AGENT || "antigravity-ide" };
}
