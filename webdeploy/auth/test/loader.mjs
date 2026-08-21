export async function resolve(specifier, context, next) {
  if (specifier === "mysql2/promise") {
    return { url: new URL("./stub-mysql2.mjs", import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
}
