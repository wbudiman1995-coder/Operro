/**
 * Shared mutation-state shape and its idle value.
 *
 * `app/schedule/actions.ts` carries the module-level "use server" directive, which marks
 * every export in that file as a Server Action reference for the client bundler. A plain
 * data value like `IDLE_STATE` does not belong there — it lives here instead, so the
 * "use server" file exports nothing but the async action functions themselves.
 */
export interface MutationState {
  error: string | null;
  success: string | null;
}

export const IDLE_STATE: MutationState = {
  error: null,
  success: null,
};
