/** Deep-freezes in place: data handed to bot code cannot change under the client. */
export function freezeData<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) freezeData(child);
    Object.freeze(value);
  }
  return value;
}

export function immutableCopy<T>(value: T): T {
  return freezeData(structuredClone(value));
}
