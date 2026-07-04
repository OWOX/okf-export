// A hand-mock matching the real @owox/plugin-sdk surface, swapped in by vitest's alias.
// Mirrors the real (async) shape: settings/storage/backend return Promises; ui.toast is 1-arg.
// Tests override these via vi.spyOn.
export const settings = {
  get: async (_key: string): Promise<unknown> => undefined,
  all: async (): Promise<Record<string, unknown>> => ({}),
};
export const storage = {
  get: async (_key: string): Promise<unknown> => undefined,
  set: async (_key: string, _value: unknown): Promise<void> => {},
  delete: async (_key: string): Promise<void> => {},
  keys: async (_prefix?: string): Promise<string[]> => [],
};
export const backend = { call: async (_fn: string, _args?: unknown): Promise<unknown> => ({ ok: true, count: 0, pushed: null }) };
export const ui = { toast: (_msg: string) => {} };
export const owox = {} as any;
export const ai = {} as any;
export const git = {} as any;
export const sheets = {} as any;
export const credentials = {} as any;
