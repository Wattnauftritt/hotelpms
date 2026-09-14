import { useQuery } from '@tanstack/react-query'
import { api } from '../api.js'

/**
 * Die Rechte dieses Benutzers in diesem Haus.
 *
 * Sie stehen schon in der Antwort von `/v1/auth/me`, die der Rahmen beim
 * Start holt; hier wird nur derselbe Zwischenspeicher gelesen. Das kostet
 * keine zusaetzliche Runde und haelt die Maske ehrlich: wer nur lesen darf,
 * sieht keinen Knopf, der ihm eine 403 antwortet. Die Sicherheit liegt in
 * der API und nirgends sonst -- das hier ist Brauchbarkeit.
 */
export function useRechte(propertyId: number): readonly string[] {
  const me = useQuery<{ properties: Array<{ id: number; permissions: string[] }> }>({
    queryKey: ['me'],
    queryFn: () => api.get('/v1/auth/me'),
    retry: false
  })
  return me.data?.properties.find(p => p.id === propertyId)?.permissions ?? []
}
