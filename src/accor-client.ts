import type {
  Hotel,
  HotelDetails,
  SpecialOffer,
  AlgoliaResponse,
  AlgoliaHit,
} from "./types.js";
import { listHotelRooms } from "./graphql-client.js";

const ALGOLIA_APP_ID = "TEBW21BCFZ";
const ALGOLIA_API_KEY = "1a6f0c3b77791a299d98f6b981f2715d";
const ALGOLIA_INDEX = "prod_hotels_en";
const ALGOLIA_BASE = `https://${ALGOLIA_APP_ID}-dsn.algolia.net/1/indexes/${ALGOLIA_INDEX}`;

const ALGOLIA_HEADERS = {
  "X-Algolia-Application-Id": ALGOLIA_APP_ID,
  "X-Algolia-API-Key": ALGOLIA_API_KEY,
  "Content-Type": "application/json",
  Referer: "https://all.accor.com/",
  Origin: "https://all.accor.com",
};

const HOTEL_ATTRIBUTES = [
  "objectID",
  "name",
  "brandLabel",
  "brand",
  "city",
  "country",
  "stars",
  "rating",
  "localization",
  "freeAmenities",
  "paidAmenities",
  "mediaCatalog",
  "medias",
  "description",
  "enhancedDescription",
  "labels",
  "isNewOpening",
  "isLoyaltyProgramParticipating",
  "loyaltyProgram",
  "status",
  "thematics",
];

function hotelUrl(id: string): string {
  return `https://all.accor.com/hotel/${id}/index.en.shtml`;
}

function bookingUrl(
  id: string,
  checkin?: string,
  checkout?: string,
  adults?: number,
  rooms?: number
): string {
  if (!checkin || !checkout) return hotelUrl(id);
  const params = new URLSearchParams({
    hotelCode: id,
    checkIn: checkin,
    checkOut: checkout,
    numberOfRooms: String(rooms ?? 1),
    adults: String(adults ?? 2),
  });
  return `https://all.accor.com/ssr/app/accor/rates?${params.toString()}`;
}

function extractLabels(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((l) => {
      if (typeof l === "string") return l;
      if (l && typeof l === "object") {
        const o = l as Record<string, unknown>;
        return String(o.value ?? o.label ?? o.code ?? "");
      }
      return "";
    })
    .filter(Boolean);
}

function mapHit(hit: AlgoliaHit): Hotel {
  const id = hit.objectID;
  const rating = hit.rating as { score?: number; nbReviews?: number } | undefined;
  const loc = hit.localization as {
    address?: { street?: string; zipCode?: string; city?: string; country?: string; countryCode?: string };
    gps?: { lat?: string | number; lng?: string | number };
  } | undefined;

  return {
    id,
    name: String(hit.name ?? "Unknown Hotel"),
    brand: String(hit.brandLabel ?? hit.brand ?? ""),
    city: String(hit.city ?? loc?.address?.city ?? ""),
    country: String(hit.country ?? loc?.address?.country ?? ""),
    stars: typeof hit.stars === "number" ? hit.stars : 0,
    ratingScore: rating?.score ?? null,
    ratingCount: rating?.nbReviews ?? null,
    labels: extractLabels(hit.labels),
    isNewOpening: Boolean(hit.isNewOpening),
    hasMemberRate: Boolean(
      (hit.loyaltyProgram as { memberRate?: boolean } | undefined)?.memberRate
    ),
    bookingUrl: hotelUrl(id),
  };
}

function mapHitToDetails(hit: AlgoliaHit): HotelDetails {
  const id = hit.objectID;
  const rating = hit.rating as { score?: number; nbReviews?: number } | undefined;
  const loc = hit.localization as {
    address?: { street?: string; line1?: string; zipCode?: string; city?: string; country?: string; countryCode?: string };
    gps?: { lat?: string | number; lng?: string | number };
    timeZone?: string;
  } | undefined;

  const freeAmenities = (
    hit.freeAmenities as Array<{ code?: string; label?: string }> | undefined
  )?.map((a) => a.label ?? a.code ?? "") ?? [];

  const paidAmenities = (
    hit.paidAmenities as Array<{ code?: string; label?: string }> | undefined
  )?.map((a) => a.label ?? a.code ?? "") ?? [];

  const images: string[] = [];
  const catalog = hit.mediaCatalog as Record<string, string> | undefined;
  if (catalog?.["1024x768"]) images.push(catalog["1024x768"]);
  if (catalog?.["2048x1536"]) images.push(catalog["2048x1536"]);
  const medias = hit.medias as { dmUrlCrop3by2?: string } | undefined;
  if (medias?.dmUrlCrop3by2) images.push(medias.dmUrlCrop3by2);

  const gps = loc?.gps;
  const addr = loc?.address;

  const thematics = (hit.thematics as string[] | undefined) ?? [];

  return {
    id,
    name: String(hit.name ?? ""),
    brand: String(hit.brandLabel ?? hit.brand ?? ""),
    address: {
      street: String(addr?.street ?? addr?.line1 ?? ""),
      city: String(addr?.city ?? ""),
      postalCode: String(addr?.zipCode ?? ""),
      country: String(addr?.country ?? ""),
      countryCode: String(addr?.countryCode ?? ""),
    },
    coordinates:
      gps?.lat && gps?.lng
        ? { lat: Number(gps.lat), lng: Number(gps.lng) }
        : null,
    stars: typeof hit.stars === "number" ? hit.stars : null,
    ratingScore: rating?.score ?? null,
    ratingCount: rating?.nbReviews ?? null,
    freeAmenities,
    paidAmenities,
    images,
    description: hit.description ? String(hit.description) : null,
    enhancedDescription: hit.enhancedDescription
      ? String(hit.enhancedDescription)
      : null,
    labels: extractLabels(hit.labels),
    thematics,
    isNewOpening: Boolean(hit.isNewOpening),
    hasMemberRate: Boolean(
      (hit.loyaltyProgram as { memberRate?: boolean } | undefined)?.memberRate
    ),
    bookingUrl: hotelUrl(id),
  };
}

// ── Hotel Search ─────────────────────────────────────────────────────────────

export async function searchHotels(opts: {
  destination: string;
  brand?: string;
  stars?: number;
  hitsPerPage?: number;
  checkin?: string;
  checkout?: string;
  adults?: number;
  rooms?: number;
  hasApartment?: boolean;
}): Promise<{ hotels: Hotel[]; total: number; apartmentFiltered: boolean }> {
  const { destination, brand, stars, hitsPerPage = 10, checkin, checkout, adults, rooms, hasApartment } = opts;

  const filters: string[] = ["status:OPEN"];
  if (brand) filters.push(`brandLabel:"${brand}"`);
  if (stars) filters.push(`stars=${stars}`);

  // When apartment filter is on, fetch ALL relevant candidates so we don't miss
  // mid-tier brands (e.g. Mercure, Novotel) that rank lower in Algolia. Algolia's
  // hard limit is 1000 per page; 200 covers any single city without paginating.
  const algoliaPageSize = hasApartment ? 200 : Math.min(hitsPerPage, 50);

  const body: Record<string, unknown> = {
    query: destination,
    hitsPerPage: algoliaPageSize,
    attributesToRetrieve: HOTEL_ATTRIBUTES,
    filters: filters.join(" AND "),
  };

  const res = await fetch(`${ALGOLIA_BASE}/query`, {
    method: "POST",
    headers: ALGOLIA_HEADERS,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Algolia search failed: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as AlgoliaResponse;
  let hotels = data.hits.map((h) => {
    const hotel = mapHit(h);
    if (checkin && checkout) {
      hotel.bookingUrl = bookingUrl(hotel.id, checkin, checkout, adults, rooms);
    }
    return hotel;
  });

  if (hasApartment) {
    hotels = await filterToApartmentBearingHotels(hotels, hitsPerPage);
  }

  return { hotels, total: data.nbHits, apartmentFiltered: !!hasApartment };
}

// Verify each candidate has at least one APARTMENT-classified accommodation
// via HotelPageCold. N+1 GraphQL calls — bounded by Algolia page size.
async function filterToApartmentBearingHotels(
  candidates: Hotel[],
  desiredCount: number
): Promise<Hotel[]> {
  const BATCH = 8;
  const survivors: Hotel[] = [];

  for (let i = 0; i < candidates.length && survivors.length < desiredCount; i += BATCH) {
    const slice = candidates.slice(i, i + BATCH);
    const checks = await Promise.all(
      slice.map(async (h) => {
        try {
          const rooms = await listHotelRooms(h.id);
          const aptRooms = rooms.filter((r) => r.classificationType?.toLowerCase() === "apartment");
          if (!aptRooms.length) return null;
          // Annotate the hotel with its apartment room codes for downstream use
          const aptCodes = aptRooms.map((r) => `${r.code} (${r.name}, ${r.surfaceSquareMeter ?? "?"}m²)`);
          return { ...h, apartmentRoomCodes: aptCodes } as Hotel & { apartmentRoomCodes: string[] };
        } catch {
          return null;
        }
      })
    );
    for (const r of checks) {
      if (r && survivors.length < desiredCount) survivors.push(r);
    }
  }
  return survivors;
}

// ── Hotel Details ─────────────────────────────────────────────────────────────

export async function getHotelDetails(
  hotelId: string,
  opts?: { checkin?: string; checkout?: string; adults?: number; rooms?: number }
): Promise<HotelDetails> {
  const res = await fetch(`${ALGOLIA_BASE}/${encodeURIComponent(hotelId)}`, {
    method: "GET",
    headers: ALGOLIA_HEADERS,
  });

  if (!res.ok) {
    throw new Error(
      `Hotel not found (ID: ${hotelId}): ${res.status} ${res.statusText}`
    );
  }

  const hit = (await res.json()) as AlgoliaHit;
  const details = mapHitToDetails(hit);

  if (opts?.checkin && opts?.checkout) {
    details.bookingUrl = bookingUrl(
      hotelId,
      opts.checkin,
      opts.checkout,
      opts.adults,
      opts.rooms
    );
  }

  return details;
}

// ── Special Rates ─────────────────────────────────────────────────────────────

export async function searchSpecialRates(opts: {
  destination?: string;
  brand?: string;
  rateType?: "new_opening" | "highly_rated" | "luxury" | "all";
  hitsPerPage?: number;
}): Promise<SpecialOffer[]> {
  const {
    destination = "",
    brand,
    rateType = "new_opening",
    hitsPerPage = 10,
  } = opts;

  const filters: string[] = ["status:OPEN"];

  if (rateType === "new_opening") {
    filters.push("isNewOpening:true");
  } else if (rateType === "highly_rated") {
    filters.push("ratingLvlFacet:3");
  } else if (rateType === "luxury") {
    filters.push("stars >= 5");
  }
  // "all" — no extra filter beyond status:OPEN

  if (brand) filters.push(`brandLabel:"${brand}"`);

  const body: Record<string, unknown> = {
    query: destination,
    hitsPerPage: Math.min(hitsPerPage, 50),
    attributesToRetrieve: HOTEL_ATTRIBUTES,
    filters: filters.join(" AND "),
  };

  const res = await fetch(`${ALGOLIA_BASE}/query`, {
    method: "POST",
    headers: ALGOLIA_HEADERS,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Algolia search failed: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as AlgoliaResponse;

  return data.hits.map((h): SpecialOffer => {
    const hotel = mapHit(h);
    const types: string[] = [];
    if (hotel.isNewOpening) types.push("New Opening");
    if (hotel.hasMemberRate) types.push("ALL Member Rate");
    if (hotel.labels.some((l) => l.toLowerCase().includes("best price")))
      types.push("Best Price Guarantee");

    return {
      hotelId: hotel.id,
      hotelName: hotel.name,
      brand: hotel.brand,
      city: hotel.city,
      country: hotel.country,
      stars: hotel.stars,
      ratingScore: hotel.ratingScore,
      offerTypes: types,
      bookingUrl: hotel.bookingUrl,
    };
  });
}
