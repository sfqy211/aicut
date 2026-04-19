const jsonHeaders = { "content-type": "application/json" };

export async function apiGet<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(await response.text());
  return (await response.json()) as T;
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(await response.text());
  return (await response.json()) as T;
}
