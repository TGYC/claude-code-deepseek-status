export type DeepseekBalance = { currency: string; total: string }

export type DeepseekModel = { id: string; name: string | null }

export type DeepseekStatus = {
  /** True only when the session talks to a DeepSeek endpoint. */
  isDeepseek: boolean
  /** The main loop's model, as `/model` shows it. */
  model: string | null
  /** Every currency the balance endpoint answered. */
  balances: DeepseekBalance[]
  /** `is_available` from the balance endpoint. */
  isAvailable: boolean
  /** Why the last balance refresh failed, when it did. */
  error: string | null
  /** When the balances were last read, in milliseconds since the epoch. */
  updatedAt: number | null
  /** The models the provider's `/models` endpoint lists. */
  models: DeepseekModel[]
  /** Why the last model-list refresh failed, when it did. */
  modelsError: string | null
  /** When the model list was last read, in milliseconds since the epoch. */
  modelsUpdatedAt: number | null
  /** The active reasoning effort, null when the model takes none. */
  effort: string | null
  /** True while ultracode ("Ultra") is on for the session. */
  isUltra: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'deepseek-status': {
      status: Shaped<DeepseekStatus>
      /** The Ultra animation's frame, 0 to 23. */
      animation: number
    }
  }
}
