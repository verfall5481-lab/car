import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { MapPin } from 'lucide-react';
import type { Coordinates } from '@deriro/contracts';
import { copy } from '../copy.ts';
import { RpcError } from './errors.ts';

export const MapKeyContext = createContext<string | null>(null);
export const useMapKey = () => useContext(MapKeyContext);
export type PlaceResult = Coordinates & { id: string; name: string; address: string };
type LatLng = { getLat(): number; getLng(): number };
type MapHandle = { getCenter(): LatLng; setCenter(latLng: LatLng): void; relayout(): void };
type KakaoMaps = {
  load(callback: () => void): void;
  LatLng: new (lat: number, lng: number) => LatLng;
  Map: new (node: HTMLElement, options: { center: LatLng; level: number; draggable: boolean; keyboardShortcuts: boolean }) => MapHandle;
  Marker: new (options: { position: LatLng; map: MapHandle }) => { setMap(map: MapHandle | null): void; setPosition(position: LatLng): void };
  event: { addListener(map: MapHandle, event: 'dragend' | 'idle', listener: () => void): void; removeListener(map: MapHandle, event: 'dragend' | 'idle', listener: () => void): void };
  services: {
    Places: new () => { keywordSearch(word: string, callback: (rows: Array<{ id: string; place_name: string; road_address_name: string; address_name: string; x: string; y: string }>, status: string) => void, options: { size: number }): void };
    Geocoder: new () => { coord2Address(lng: number, lat: number, callback: (rows: Array<{ road_address: { address_name: string } | null; address: { address_name: string } }>, status: string) => void): void };
    Status: { OK: string; ZERO_RESULT: string };
  };
};

const scriptLoads = new Map<string, Promise<KakaoMaps>>();
function getMaps() { return (window as Window & { kakao?: { maps: KakaoMaps } }).kakao?.maps; }
function kakao(key: string): Promise<KakaoMaps> {
  const active = scriptLoads.get(key);
  if (active) return active;
  const loading = new Promise<KakaoMaps>((resolve, reject) => {
    const script = document.createElement('script');
    const timeout = window.setTimeout(() => { script.remove(); reject(new RpcError('MAP_UNAVAILABLE')); }, 8_000);
    script.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${encodeURIComponent(key)}&libraries=services&autoload=false`;
    script.async = true;
    script.onerror = () => { window.clearTimeout(timeout); script.remove(); reject(new RpcError('MAP_UNAVAILABLE')); };
    script.onload = () => {
      const maps = getMaps();
      if (!maps) { window.clearTimeout(timeout); script.remove(); reject(new RpcError('MAP_UNAVAILABLE')); return; }
      maps.load(() => { window.clearTimeout(timeout); resolve(maps); });
    };
    document.head.append(script);
  });
  scriptLoads.set(key, loading);
  void loading.catch(() => scriptLoads.delete(key));
  return loading;
}

export async function searchPlaces(key: string, term: string): Promise<PlaceResult[]> {
  const maps = await kakao(key);
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new RpcError('MAP_UNAVAILABLE')), 8_000);
    new maps.services.Places().keywordSearch(term, (rows, status) => {
      window.clearTimeout(timer);
      if (status === maps.services.Status.ZERO_RESULT) resolve([]);
      else if (status === maps.services.Status.OK) resolve(rows.map((row) => ({ id: row.id, name: row.place_name, address: row.road_address_name || row.address_name, lat: Number(row.y), lng: Number(row.x) })));
      else reject(new RpcError('MAP_UNAVAILABLE'));
    }, { size: 8 });
  });
}

export async function reverseAddress(key: string, coords: Coordinates): Promise<string | null> {
  const maps = await kakao(key);
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => resolve(null), 6_000);
    new maps.services.Geocoder().coord2Address(coords.lng, coords.lat, (rows, status) => {
      window.clearTimeout(timer);
      const result = rows[0];
      resolve(status === maps.services.Status.OK && result ? result.road_address?.address_name || result.address.address_name : null);
    });
  });
}

export function LiveMap({ coords, onMove, marker }: { coords?: Coordinates; onMove?: (value: Coordinates) => void; marker?: string }) {
  const key = useMapKey();
  const container = useRef<HTMLDivElement>(null);
  const handle = useRef<{ map: MapHandle; maps: KakaoMaps; marker?: InstanceType<KakaoMaps['Marker']> } | null>(null);
  const callback = useRef(onMove);
  const point = useRef(coords);
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => { callback.current = onMove; }, [onMove]);
  useEffect(() => {
    point.current = coords;
    if (!coords || !handle.current) return;
    const { map, maps, marker } = handle.current;
    const at = map.getCenter();
    if (Math.abs(at.getLat() - coords.lat) + Math.abs(at.getLng() - coords.lng) > 0.00001) {
      const target = new maps.LatLng(coords.lat, coords.lng);
      map.setCenter(target);
      marker?.setPosition(target);
    }
  }, [coords]);
  const hasCoordinates = Boolean(coords);
  const movable = Boolean(onMove);
  useEffect(() => {
    if (!key || !hasCoordinates) return;
    setFailed(false);
    setLoaded(false);
    let active = true;
    let dispose: (() => void) | undefined;
    void kakao(key).then((maps) => {
      if (!active || !container.current || !point.current) return;
      const center = new maps.LatLng(point.current.lat, point.current.lng);
      const map = new maps.Map(container.current, { center, level: 4, draggable: movable, keyboardShortcuts: movable });
      const mark = movable ? undefined : new maps.Marker({ position: center, map });
      handle.current = { maps, map, marker: mark };
      const listen = () => { const pos = map.getCenter(); callback.current?.({ lat: pos.getLat(), lng: pos.getLng() }); };
      if (movable) maps.event.addListener(map, 'idle', listen);
      const observer = new ResizeObserver(() => map.relayout());
      observer.observe(container.current);
      dispose = () => { observer.disconnect(); mark?.setMap(null); if (movable) maps.event.removeListener(map, 'idle', listen); handle.current = null; };
      setLoaded(true);
    }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; dispose?.(); };
  }, [key, hasCoordinates, movable]);
  if (!key || failed || !coords) return <div className="map-unavailable" role="img" aria-label={copy.mapUnavailable}><MapPin size={25} /><span>{marker ?? copy.mapUnavailable}</span>{marker && <small>{copy.mapUnavailable}</small>}</div>;
  return <div className="live-map-wrap">
    <div className="live-map" ref={container} role={movable ? 'group' : 'img'} tabIndex={movable ? 0 : undefined} aria-label={movable ? copy.mapInstructions : copy.location} />
    {loaded && movable && <MapPin className="live-pin" size={34} fill="#f4b019" aria-hidden="true" />}
    {!loaded && <span className="live-map-loading" role="status">{copy.loading}</span>}
  </div>;
}

export function browserPosition(): Promise<Extract<import('@deriro/contracts').LocationInput, { source: 'gps' }>> {
  return new Promise((resolve, reject) => {
    if (!window.isSecureContext || !navigator.geolocation) { reject(new RpcError('GEO_UNAVAILABLE')); return; }
    navigator.geolocation.getCurrentPosition(({ coords }) => resolve({ source: 'gps', lat: coords.latitude, lng: coords.longitude, accuracyM: coords.accuracy }),
      (error) => reject(new RpcError(error.code === error.PERMISSION_DENIED ? 'GEO_DENIED' : 'GEO_UNAVAILABLE')), { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 });
  });
}

export async function locationPermission() {
  try { return (await navigator.permissions.query({ name: 'geolocation' })).state; } catch { return 'prompt'; }
}
