/** Free text from a repository, an advisory, or a person, marked as data for a model: `{ "quoted": "..." }`. */
export type Quoted = { readonly quoted: string };

export function quoted(text: string): Quoted {
  return { quoted: text };
}
