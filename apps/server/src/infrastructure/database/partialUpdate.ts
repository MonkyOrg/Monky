/** A value a statement binds as it is. */
export type SqlValue = string | number | null;

/**
 * The `SET` assignments for the fields an update carries, so a repository
 * names each column once instead of writing an `if` per field (S-APP-10). A
 * field left undefined keeps its column, and a boolean is stored as 0 or 1.
 * Null when the update carries nothing to write.
 */
export function partialUpdate<T extends object>(
  updates: Partial<T>, columns: { readonly [K in keyof T]?: string },
): { set: string; values: SqlValue[] } | null {
  const assignments: string[] = [];
  const values: SqlValue[] = [];
  for (const field in columns) {
    const column = columns[field];
    const value: unknown = updates[field];
    if (column === undefined || value === undefined) continue;
    if (typeof value === 'boolean') values.push(value ? 1 : 0);
    else if (value === null || typeof value === 'string' || typeof value === 'number') values.push(value);
    else throw new TypeError(`${field} cannot be stored in ${column}.`);
    assignments.push(`${column} = ?`);
  }
  return assignments.length > 0 ? { set: assignments.join(', '), values } : null;
}
