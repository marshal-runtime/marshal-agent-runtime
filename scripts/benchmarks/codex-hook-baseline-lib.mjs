export function readHookAdditionalContext(output) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return undefined;
  if (typeof output.additionalContext === 'string') return output.additionalContext;
  const hookSpecificOutput = output.hookSpecificOutput;
  return hookSpecificOutput &&
    typeof hookSpecificOutput === 'object' &&
    !Array.isArray(hookSpecificOutput) &&
    typeof hookSpecificOutput.additionalContext === 'string'
    ? hookSpecificOutput.additionalContext
    : undefined;
}

export function hookOutputHasContext(invocation, expected) {
  const context = readHookAdditionalContext(invocation?.output);
  return invocation?.ok === true &&
    typeof context === 'string' &&
    context.toLocaleLowerCase().includes(expected.toLocaleLowerCase());
}

export function hookContextExcerpt(invocation, maximumLength = 1_000) {
  const context = readHookAdditionalContext(invocation?.output);
  return typeof context === 'string' ? context.slice(0, maximumLength) : null;
}
