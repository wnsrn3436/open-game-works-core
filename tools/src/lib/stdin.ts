/** All of the input until EOF as UTF-8 text. A terminal is read until EOF too (Ctrl-D), never taken as empty. */
export async function readAll(input: AsyncIterable<unknown>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of input) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
  return Buffer.concat(chunks).toString('utf8');
}
