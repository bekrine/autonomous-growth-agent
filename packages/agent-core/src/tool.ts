export interface ToolResult<TOutput> {
  success: boolean;
  data?: TOutput;
  error?: string;
}

/**
 * Generic tool abstraction. Tools are the only place allowed to reach into
 * the database or a social-platform adapter — agents call tools, never the
 * underlying resource directly.
 */
export interface Tool<TInput, TOutput> {
  readonly name: string;
  readonly description: string;
  execute(input: TInput): Promise<ToolResult<TOutput>>;
}
