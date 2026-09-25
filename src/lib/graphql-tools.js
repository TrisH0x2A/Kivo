import { buildClientSchema, buildSchema, getIntrospectionQuery, parse, print, printSchema, validate } from "graphql";
import { getAutocompleteSuggestions } from "graphql-language-service";

export const introspectionQuery = getIntrospectionQuery();

export function schemaFromIntrospection(body) {
  if (typeof body === "string" && body.length > 2_000_000) throw new Error("Introspection response exceeds 2 MB.");
  const result = typeof body === "string" ? JSON.parse(body) : body;
  if (result.errors?.length) throw new Error(result.errors.map((error) => error.message).join("; "));
  if (!result.data?.__schema && !result.__schema) throw new Error("The endpoint did not return an introspection schema.");
  return printSchema(buildClientSchema(result.data || result));
}

export function parseGraphqlSchema(sdl) {
  if (!sdl) return null;
  if (sdl.length > 2_000_000) throw new Error("GraphQL schemas must be smaller than 2 MB.");
  return buildSchema(sdl);
}

export function graphqlDiagnostics(schema, query) {
  try {
    const document = parse(query, { maxTokens: 20000 });
    return schema ? validate(schema, document, undefined, { maxErrors: 25 }).map((error) => error.message) : [];
  } catch (error) { return [error.message]; }
}

export function graphqlCompletions(schema, source, cursor) {
  if (!schema || source.length > 100000) return [];
  const before = source.slice(0, cursor).split("\n");
  try {
    return getAutocompleteSuggestions(schema, source, { line: before.length - 1, character: before.at(-1).length }).map((item) => ({ label: item.label, insertText: item.label }));
  } catch { return []; }
}

export function formatGraphqlQuery(query) {
  return print(parse(query, { maxTokens: 20000 }));
}
