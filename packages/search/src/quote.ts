/**
 * Renders `value` so that RQL reads it back as exactly this string.
 *
 * Lives here because it is knowledge about the language, and the language has
 * one owner. A sidebar building `tag:Some Name` by concatenation produces two
 * terms and a wrong answer; a sidebar that has to know *when* to quote is a
 * second implementation of the grammar, waiting to disagree with this one.
 */
export function quoteValue(value: string): string {
  const plain = value !== "" && !/[\s"():]/.test(value);
  if (plain) return value;
  // `""` is the escape for a quote, per the lexer.
  return `"${value.replaceAll('"', '""')}"`;
}
