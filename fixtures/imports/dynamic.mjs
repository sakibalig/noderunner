export async function f() {
  return import("chalk");
}
export const t = import(`./lazy.js`);
