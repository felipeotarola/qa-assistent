/** Prices are integer öre; a row has unitPrice and positive integer quantity. */
export function cartTotal(rows) {
  return rows.reduce((sum, row) => sum + row.unitPrice, 0);
}
