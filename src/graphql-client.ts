const BFF_ENDPOINT = "https://api.accor.com/bff/v1/graphql";
const BFF_API_KEY = "l7xx5b9f4a053aaf43d8bc05bcc266dd8532";

function bffHeaders(identificationToken?: string): Record<string, string> {
  const h: Record<string, string> = {
    "Accept-Language": "en-GB,en;q=0.9",
    Origin: "https://all.accor.com",
    Referer: "https://all.accor.com/",
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
    accept: "*/*",
    apikey: BFF_API_KEY,
    "app-id": "all.accor",
    "app-version": "1.39.1",
    clientid: "all.accor",
    "content-type": "application/json",
    lang: "en",
  };
  if (identificationToken) h["identification-token"] = identificationToken;
  return h;
}

async function bffGql<T>(
  query: string,
  variables: Record<string, unknown>,
  operationName: string,
  identificationToken?: string
): Promise<T> {
  const res = await fetch(BFF_ENDPOINT, {
    method: "POST",
    headers: bffHeaders(identificationToken),
    body: JSON.stringify({ operationName, query, variables }),
  });
  const json = (await res.json()) as { data?: T; errors?: { message: string; extensions?: { code?: string } }[] };
  if (json.errors?.length) {
    throw new Error(json.errors[0].message);
  }
  return json.data as T;
}

// ── Card-only token bootstrap ─────────────────────────────────────────────────

const AFFILIATION_ENDPOINT = "https://api.accor.com/bff/v1/affiliation-and-identification";

interface AffiliationResponse {
  errors?: Array<{ code: string; message: string }>;
  identificationToken?: string;
  affiliation?: unknown;
}

export interface CardSummary {
  number: string;
  type: string;          // raw code (A4, G7, etc.) — Accor doesn't expose a public mapping
  kind: string;          // LOYALTY | SUBSCRIPTION | ...
  expirationDate: string | null; // YYYY-MM-DD
}

export interface MemberSummary {
  cards: CardSummary[];
  isLoyaltyMember: boolean;
  isLcahMember: boolean;
  hasLoyaltyCard: boolean;
  b2bType: string;
  tokenExpiresAt: string;       // ISO timestamp
  identificationId: string;
}

export interface BootstrapResult {
  token: string;
  summary: MemberSummary;
}

interface JwtPayload {
  exp: number;
  identificationId?: string;
  identification?: {
    b2b?: { type?: string };
    loyalty?: {
      flags?: { loyaltyCard?: boolean; loyaltyMember?: boolean; lcahMember?: boolean };
      cards?: Array<{
        number: string;
        type: string;
        kind: string;
        expirationDate?: number[];
      }>;
    };
  };
}

function decodeJwtPayload(token: string): JwtPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    let payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    while (payload.length % 4) payload += "=";
    const json = Buffer.from(payload, "base64").toString("utf8");
    return JSON.parse(json) as JwtPayload;
  } catch {
    return null;
  }
}

function summariseToken(token: string): MemberSummary {
  const p = decodeJwtPayload(token);
  const ident = p?.identification;
  const flags = ident?.loyalty?.flags ?? {};
  const cards = (ident?.loyalty?.cards ?? []).map((c): CardSummary => {
    const e = c.expirationDate;
    const expirationDate =
      Array.isArray(e) && e.length === 3
        ? `${e[0]}-${String(e[1]).padStart(2, "0")}-${String(e[2]).padStart(2, "0")}`
        : null;
    return { number: c.number, type: c.type, kind: c.kind, expirationDate };
  });
  return {
    cards,
    isLoyaltyMember: !!flags.loyaltyMember,
    isLcahMember: !!flags.lcahMember,
    hasLoyaltyCard: !!flags.loyaltyCard,
    b2bType: ident?.b2b?.type ?? "B2C",
    tokenExpiresAt: p?.exp ? new Date(p.exp * 1000).toISOString() : "",
    identificationId: p?.identificationId ?? "",
  };
}

/**
 * Exchange a public ALL Accor card number for an identification-token.
 * No password required — card number is a public identifier (the Accor site
 * itself accepts it on the homepage's "Just enter your card number" widget).
 * Returns both the raw token (for downstream GraphQL calls) and a decoded
 * summary of the linked cards / membership flags from the JWT payload.
 */
export async function bootstrapMemberToken(cardNumber: string): Promise<BootstrapResult> {
  const res = await fetch(AFFILIATION_ENDPOINT, {
    method: "POST",
    headers: {
      Accept: "*/*",
      "Accept-Language": "en-GB,en;q=0.9",
      "Content-Type": "application/json",
      Origin: "https://all.accor.com",
      Referer: "https://all.accor.com/",
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
      apiKey: BFF_API_KEY,
      clientId: "all.accor",
      "x-bff-disable-api-cache": "affiliation",
    },
    body: JSON.stringify({ identification: { cardNumber }, affiliation: {} }),
  });

  const headerToken =
    res.headers.get("identification-token") ??
    res.headers.get("x-identification-token");

  let body: AffiliationResponse | null = null;
  try {
    body = (await res.json()) as AffiliationResponse;
  } catch {
    // body may be empty/non-JSON
  }

  if (!res.ok) {
    const err = body?.errors?.[0];
    if (err?.code === "BUSINESS_INVALID_CARD") {
      throw new Error(
        `Card number "${cardNumber}" is not recognised by Accor. Check that you entered a valid ALL membership card number.`
      );
    }
    throw new Error(
      err?.message ?? `Affiliation failed: HTTP ${res.status} ${res.statusText}`
    );
  }

  const token = headerToken ?? body?.identificationToken;
  if (!token) {
    throw new Error(
      "Card was accepted but no identification-token returned. Accor may have changed the response shape."
    );
  }
  return { token, summary: summariseToken(token) };
}

// ── Shared query ──────────────────────────────────────────────────────────────

const HOTEL_OFFERS_QUERY = `
query HotelPageHot(
  $hotelOffersHotelId: String!, $dateIn: Date!, $dateOut: Date!,
  $nbAdults: PositiveInt!, $childrenAges: [NonNegativeInt!],
  $countryMarket: String!, $currency: String!,
  $offersSelectionFilters: OffersSelectionFilters,
  $use: BestOfferUse, $selectionStep: Int,
  $concession: BestOfferConcession, $hideMemberRate: Boolean,
  $selection: [OfferSelectionInput!]
) {
  hotelOffers(
    hotelId: $hotelOffersHotelId, dateIn: $dateIn, dateOut: $dateOut,
    nbAdults: $nbAdults, childrenAges: $childrenAges,
    countryMarket: $countryMarket, currency: $currency,
    use: $use, concession: $concession, hideMemberRate: $hideMemberRate
  ) {
    offersSelection(
      selectionStep: $selectionStep,
      filters: $offersSelectionFilters,
      selection: $selection
    ) {
      offers {
        accommodation { code }
        pricing {
          currency
          formattedTaxType
          main {
            formattedAmount amount
            simplifiedPolicies { cancellation { code label } }
            taxesTotalAmount {
              included { label breakdown }
              excluded { label breakdown }
            }
            feesTotalAmount {
              included { label breakdown }
              excluded { label breakdown }
            }
          }
          deduction { percent formattedAmount type }
          alternative { amount formattedAmount }
        }
        mealPlan { code label }
        lengthOfStay { value unit }
        rate { id label }
      }
    }
    availability { status reasons { code label } }
  }
}`;

function mkVars(
  hotelId: string,
  dateIn: string,
  dateOut: string,
  adults: number,
  currency: string,
  countryMarket: string
) {
  return {
    hotelOffersHotelId: hotelId,
    dateIn,
    dateOut,
    nbAdults: adults,
    childrenAges: [],
    selectionStep: 0,
    countryMarket,
    currency,
    offersSelectionFilters: { cancellationPolicies: null, isAccessible: false, mealPlans: null },
    concession: null,
    use: "NIGHT",
    hideMemberRate: false,
    selection: [],
  };
}

// ── Types ─────────────────────────────────────────────────────────────────────

// Charges (taxes or fees) on an offer. `amount` is parsed best-effort from
// the formatted label (Accor doesn't expose a numeric field) so it may be null
// for unusual locales. `breakdown` is the human-readable line items, e.g.
// "of which Good and Service Tax 18% : 18.0% (per night/per product)".
export interface ChargeSummary {
  label: string;
  amount: number | null;
  breakdown: string[];
}

// Full pricing breakdown for a single offer. `taxType` is a one-line summary
// from Accor like "Taxes and fees included." or "Taxes not included : ₹4,411.80."
// `grandTotal` is the all-in price the guest actually pays
// (= main amount + any *excluded* taxes & fees).
export interface PricingBreakdown {
  taxType: string | null;
  taxesIncluded: ChargeSummary | null;
  taxesExcluded: ChargeSummary | null;
  feesIncluded: ChargeSummary | null;
  feesExcluded: ChargeSummary | null;
  grandTotal: number | null;
  grandTotalFormatted: string | null;
}

export interface NightlyRate {
  date: string;
  dayOfWeek: string;
  available: boolean;
  roomOnlyPrice: number | null;
  roomOnlyFormatted: string | null;
  roomOnlyAllInPrice: number | null;       // includes any taxes/fees not in displayed price
  roomOnlyAllInFormatted: string | null;
  taxNote: string | null;                   // e.g. "Taxes excluded : ₹367.65"
  memberSaving: string | null;
}

export interface RateOption {
  rateLabel: string;
  mealPlan: string;
  totalAmount: number;
  totalFormatted: string;
  perNight: number;
  perNightFormatted: string;
  cancellation: string;
  memberSaving: string | null;
  nonMemberTotal: number | null;
  pricing: PricingBreakdown | null;
}

export interface HotelRatesSummary {
  hotelId: string;
  currency: string;
  checkin: string;
  checkout: string;
  nights: number;
  nightly: NightlyRate[];
  roomOnlyStats: {
    min: number;
    max: number;
    avg: number;
    total: number;
    allInTotal: number;          // sum of nightly all-in prices (= total + any excluded taxes/fees)
    availableNights: number;
    cheapestDay: string;
    mostExpensiveDay: string;
  } | null;
  fullStayOptions: RateOption[];
  bookingStrategies: BookingStrategy[];
}

export interface ChunkResult {
  dateIn: string;
  dateOut: string;
  nights: number;
  available: boolean;
  cheapestRoomOnlyTotal: number | null;
  cheapestRoomOnlyFormatted: string | null;
  cheapestRoomOnlyAllInTotal: number | null;
  cheapestRoomOnlyAllInFormatted: string | null;
  pricing: PricingBreakdown | null;
  unavailabilityReason: string | null;
}

export interface BookingStrategy {
  strategyLabel: string;          // "Full stay", "2-week chunks", "1-week chunks"
  chunkPattern: string;            // "31 nights" or "14+14+3" etc.
  chunks: ChunkResult[];
  allBookable: boolean;
  totalIfAllBookable: number | null;
  totalAllInIfAllBookable: number | null;
}

// ── Hotel accommodations (room catalog) ───────────────────────────────────────

export interface HotelRoom {
  code: string;
  name: string;
  description: string | null;
  classificationStandard: string;
  classificationType: string;
  surfaceSquareMeter: number | null;
  maxOccupancy: number | null;
  bedding: string;
  features: string[];
  isAccessible: boolean;
}

const HOTEL_ROOMS_QUERY = `
query HotelAccommodations($hotelId: ID!, $surfaceUnit: String, $babyDetails: Boolean) {
  hotel(hotelId: $hotelId) {
    name
    accommodations {
      code name description isAccessible
      keyFeatures(surfaceUnit: $surfaceUnit, babyDetails: $babyDetails) { code label }
      maxOccupancy { pax }
      beddingDetails { code count label }
      classification {
        standard { code label }
        type { code label }
      }
      surface { squareMeter squareFeet }
    }
  }
}`;

interface AccommodationData {
  code: string;
  name: string;
  description: string | null;
  isAccessible: boolean;
  keyFeatures: Array<{ code: string; label: string }> | null;
  maxOccupancy: { pax: number } | null;
  beddingDetails: Array<{ code: string; count: number; label: string }> | null;
  classification: {
    standard: { code: string; label: string } | null;
    type: { code: string; label: string } | null;
  } | null;
  surface: { squareMeter: number | null; squareFeet: number | null } | null;
}

export async function listHotelRooms(hotelId: string): Promise<HotelRoom[]> {
  const data = await bffGql<{ hotel: { name: string; accommodations: AccommodationData[] } }>(
    HOTEL_ROOMS_QUERY,
    { hotelId, surfaceUnit: "meters", babyDetails: false },
    "HotelAccommodations"
  );
  return (data.hotel.accommodations ?? []).map((a) => ({
    code: a.code,
    name: a.name,
    description: a.description,
    classificationStandard: a.classification?.standard?.label ?? "",
    classificationType: a.classification?.type?.label ?? "",
    surfaceSquareMeter: a.surface?.squareMeter ?? null,
    maxOccupancy: a.maxOccupancy?.pax ?? null,
    bedding: (a.beddingDetails ?? []).map((b) => `${b.count}× ${b.label}`).join(", "),
    features: (a.keyFeatures ?? []).map((f) => f.label),
    isAccessible: a.isAccessible,
  }));
}

// ── Full hotel details (HotelPageCold) ────────────────────────────────────────

export interface HotelGqlReview {
  author: string;
  rating: number | null;
  title: string | null;
  text: string;
  date: string;
  tripType: string | null;
}

export interface HotelGqlFacilityItem {
  code?: string;
  name: string;
  description: string | null;
}

export interface HotelGqlMediaItem {
  category: string;
  type: string;
  url: string | null;
  width: number | null;
  height: number | null;
}

export interface HotelGqlDetails {
  id: string;
  name: string;
  brand: { code: string; label: string; description: string | null };
  description: { destination: string; general: string; seo: string } | null;
  flashInfo: string | null;
  managerMessage: { firstName: string; lastName: string; message: string } | null;
  topAmenities: string[];
  amenityCategories: string[];
  advantages: string[];
  labels: string[];
  certifications: Array<{ code: string; label: string; description: string | null }>;
  loyaltyProgram: { burnAllowed: boolean; status: string } | null;
  contact: { phone: string | null; email: string | null };
  address: {
    street: string; city: string; zipCode: string; state: string;
    country: string; countryCode: string;
  };
  coordinates: { lat: number; lng: number } | null;
  formattedCheckIn: string | null;
  formattedCheckOut: string | null;
  rating: {
    stars: number | null;
    score: number | null;
    numberOfReviews: number | null;
    origin: string | null;
    reviews: HotelGqlReview[];
  };
  totalMedias: number;
  totalVideos: number;
  mediaItems: HotelGqlMediaItem[];
  roomOccupancy: { maxAdult: number; maxChild: number; maxPax: number; maxRoom: number } | null;
  paymentMeans: string[];
  presentationKickers: string[];
  facilities: {
    breakfasts: HotelGqlFacilityItem[];
    fitnessCenters: HotelGqlFacilityItem[];
    pools: HotelGqlFacilityItem[];
    restaurants: HotelGqlFacilityItem[];
    bars: HotelGqlFacilityItem[];
    spas: HotelGqlFacilityItem[];
  };
  amenitiesInventory: { connectingRooms: boolean | null; familyRooms: boolean | null } | null;
  accommodations: HotelRoom[];
}

// Trimmed HotelPageCold — drops fragment shapes we don't render but keeps the rich payload
const HOTEL_DETAILS_GQL_QUERY = `
query HotelDetailsGql(
  $hotelId: ID!,
  $topAmenitiesLimit: PositiveInt,
  $reviewsLimit: PositiveInt!,
  $mediasLimit: PositiveInt,
  $mediaContext: MediaContext,
  $mediaCategories: [MediaCategory!],
  $program: V2HotelPaymentMeansInput!,
  $descriptionMarkupLanguage: MarkupLanguage,
  $surfaceUnit: String,
  $babyDetails: Boolean
) {
  hotel(hotelId: $hotelId) {
    id name flashInfo
    brand { code label description }
    V2description { destination general seo }
    manager { firstName lastName message }
    topAmenities(limit: $topAmenitiesLimit) { code label }
    amenityCategories { code label }
    advantages
    contact {
      phone { number { formatted { international } } label }
      email
    }
    rating {
      stars
      default { numberOfReviews origin score }
      reviews(limit: $reviewsLimit) {
        items { author rating title text date tripType }
      }
    }
    labels { code label description }
    certifications(descriptionMarkupLanguage: $descriptionMarkupLanguage) { code label description }
    loyaltyProgram { burnAllowed status }
    localization {
      address { city country countryCode state street zipCode }
      gps { lat lng }
    }
    formattedCheckIn formattedCheckOut
    totalMedias: medias(types: [IMAGE, VIDEO], productCodes: "GENERIC", categories: $mediaCategories) { total }
    totalVideos: medias(types: [VIDEO], productCodes: "GENERIC", categories: $mediaCategories) { total }
    medias(types: [IMAGE], categories: $mediaCategories, limit: $mediasLimit, context: $mediaContext) {
      items {
        category type
        availableFormats { url width height }
      }
    }
    paymentMeans(program: $program) { items { code label } }
    roomOccupancy { maxAdult maxChild maxPax maxRoom }
    presentationHints { kickers { code label } }
    accommodations {
      code name description isAccessible
      keyFeatures(surfaceUnit: $surfaceUnit, babyDetails: $babyDetails) { code label }
      maxOccupancy { pax }
      beddingDetails { code count label }
      classification { standard { code label } type { code label } }
      surface { squareMeter squareFeet }
    }
    v2facilities {
      breakfasts { name description }
      fitnessCenters { name description }
      pools { name description }
      restaurants { items { code name description } }
      bars { items { code name description } }
      spas { items { name description } }
    }
  }
  amenities(hotelId: $hotelId) {
    inventory { connectingRooms familyRooms }
  }
}`;

interface HotelDetailsGqlResponse {
  hotel: {
    id: string;
    name: string;
    flashInfo: string | null;
    brand: { code: string; label: string; description: string | null };
    V2description: { destination: string; general: string; seo: string } | null;
    manager: { firstName: string; lastName: string; message: string } | null;
    topAmenities: Array<{ code: string; label: string }>;
    amenityCategories: Array<{ code: string; label: string }>;
    advantages: string[] | null;
    contact: {
      phone: { number: { formatted: { international: string | null } } | null; label: string | null } | null;
      email: string | null;
    } | null;
    rating: {
      stars: number | null;
      default: { numberOfReviews: number | null; origin: string | null; score: number | null } | null;
      reviews: { items: Array<{ author: string; rating: number | null; title: string | null; text: string; date: string; tripType: string | null }> } | null;
    } | null;
    labels: Array<{ code: string; label: string; description: string | null }> | null;
    certifications: Array<{ code: string; label: string; description: string | null }> | null;
    loyaltyProgram: { burnAllowed: boolean; status: string } | null;
    localization: {
      address: { city: string; country: string; countryCode: string; state: string; street: string; zipCode: string } | null;
      gps: { lat: number; lng: number } | null;
    } | null;
    formattedCheckIn: string | null;
    formattedCheckOut: string | null;
    totalMedias: { total: number } | null;
    totalVideos: { total: number } | null;
    medias: { items: Array<{ category: string; type: string; availableFormats: Array<{ url: string; width: number; height: number }> | null }> } | null;
    paymentMeans: { items: Array<{ code: string; label: string }> } | null;
    roomOccupancy: { maxAdult: number; maxChild: number; maxPax: number; maxRoom: number } | null;
    presentationHints: { kickers: Array<{ code: string; label: string }> } | null;
    accommodations: AccommodationData[];
    v2facilities: {
      breakfasts: { name: string; description: string | null } | null;
      fitnessCenters: { name: string; description: string | null } | null;
      pools: { name: string; description: string | null } | null;
      restaurants: { items: Array<{ code: string; name: string; description: string | null }> } | null;
      bars: { items: Array<{ code: string; name: string; description: string | null }> } | null;
      spas: { items: Array<{ name: string; description: string | null }> } | null;
    } | null;
  };
  amenities: { inventory: { connectingRooms: boolean | null; familyRooms: boolean | null } | null } | null;
}

const MEDIA_CATEGORIES = [
  "VIDEO","HOTEL","CUSTOMER_MEDIA","BEDROOM","SUITE","RESTAURANT","BAR","BREAKFAST",
  "FAMILY","WEDDING","MEETING_ROOM","BUSINESS_CENTER","SERVICE","HOTEL_ADVANTAGE",
  "SPA","GOLF","THALASSO","INSTITUTE","DESTINATION","SUSTAINABLE_DEVELOPMENT","FITNESS","POOL",
];

export async function getHotelDetailsGql(hotelId: string): Promise<HotelGqlDetails> {
  const data = await bffGql<HotelDetailsGqlResponse>(
    HOTEL_DETAILS_GQL_QUERY,
    {
      hotelId,
      topAmenitiesLimit: 12,
      reviewsLimit: 6,
      mediasLimit: 6,
      mediaContext: "LIST",
      mediaCategories: MEDIA_CATEGORIES,
      program: "WEB",
      descriptionMarkupLanguage: "HTML",
      surfaceUnit: "meters",
      babyDetails: false,
    },
    "HotelDetailsGql"
  );

  const h = data.hotel;
  const accommodations: HotelRoom[] = (h.accommodations ?? []).map((a) => ({
    code: a.code,
    name: a.name,
    description: a.description,
    classificationStandard: a.classification?.standard?.label ?? "",
    classificationType: a.classification?.type?.label ?? "",
    surfaceSquareMeter: a.surface?.squareMeter ?? null,
    maxOccupancy: a.maxOccupancy?.pax ?? null,
    bedding: (a.beddingDetails ?? []).map((b) => `${b.count}× ${b.label}`).join(", "),
    features: (a.keyFeatures ?? []).map((f) => f.label),
    isAccessible: a.isAccessible,
  }));

  const reviewsList = h.rating?.reviews?.items ?? [];
  const mediasList = h.medias?.items ?? [];
  const facilities = h.v2facilities;

  const mapFacility = (x: { name: string; description: string | null } | null | undefined): HotelGqlFacilityItem[] =>
    x && x.name ? [{ name: x.name, description: x.description }] : [];
  const mapFacilityItems = (xs: { items: Array<{ code?: string; name: string; description: string | null }> } | null | undefined): HotelGqlFacilityItem[] =>
    (xs?.items ?? []).map((x) => ({ code: x.code, name: x.name, description: x.description }));

  return {
    id: h.id,
    name: h.name,
    brand: h.brand,
    description: h.V2description,
    flashInfo: h.flashInfo,
    managerMessage: h.manager,
    topAmenities: (h.topAmenities ?? []).map((a) => a.label),
    amenityCategories: (h.amenityCategories ?? []).map((a) => a.label),
    advantages: h.advantages ?? [],
    labels: (h.labels ?? []).map((l) => l.label),
    certifications: (h.certifications ?? []).map((c) => ({ code: c.code, label: c.label, description: c.description })),
    loyaltyProgram: h.loyaltyProgram,
    contact: {
      phone: h.contact?.phone?.number?.formatted?.international ?? null,
      email: h.contact?.email ?? null,
    },
    address: {
      street: h.localization?.address?.street ?? "",
      city: h.localization?.address?.city ?? "",
      zipCode: h.localization?.address?.zipCode ?? "",
      state: h.localization?.address?.state ?? "",
      country: h.localization?.address?.country ?? "",
      countryCode: h.localization?.address?.countryCode ?? "",
    },
    coordinates: h.localization?.gps ?? null,
    formattedCheckIn: h.formattedCheckIn,
    formattedCheckOut: h.formattedCheckOut,
    rating: {
      stars: h.rating?.stars ?? null,
      score: h.rating?.default?.score ?? null,
      numberOfReviews: h.rating?.default?.numberOfReviews ?? null,
      origin: h.rating?.default?.origin ?? null,
      reviews: reviewsList.map((r) => ({
        author: r.author,
        rating: r.rating,
        title: r.title,
        text: r.text,
        date: r.date,
        tripType: r.tripType,
      })),
    },
    totalMedias: h.totalMedias?.total ?? 0,
    totalVideos: h.totalVideos?.total ?? 0,
    mediaItems: mediasList.flatMap((m) => {
      const fmts = m.availableFormats ?? [];
      const largest = fmts.length ? fmts.reduce((a, b) => ((a.width ?? 0) > (b.width ?? 0) ? a : b)) : null;
      return [{ category: m.category, type: m.type, url: largest?.url ?? null, width: largest?.width ?? null, height: largest?.height ?? null }];
    }),
    roomOccupancy: h.roomOccupancy,
    paymentMeans: (h.paymentMeans?.items ?? []).map((p) => p.label),
    presentationKickers: (h.presentationHints?.kickers ?? []).map((k) => k.label),
    facilities: {
      breakfasts: mapFacility(facilities?.breakfasts),
      fitnessCenters: mapFacility(facilities?.fitnessCenters),
      pools: mapFacility(facilities?.pools),
      restaurants: mapFacilityItems(facilities?.restaurants),
      bars: mapFacilityItems(facilities?.bars),
      spas: mapFacilityItems(facilities?.spas),
    },
    amenitiesInventory: data.amenities?.inventory ?? null,
    accommodations,
  };
}

// ── Hotel rates (day-by-day) ──────────────────────────────────────────────────

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function nightCount(checkin: string, checkout: string): number {
  return Math.round(
    (new Date(checkout + "T00:00:00Z").getTime() - new Date(checkin + "T00:00:00Z").getTime()) /
      86400000
  );
}

interface ChargeDetailsData {
  label: string | null;
  breakdown: string[];
}

interface OfferData {
  pricing: {
    currency: string;
    formattedTaxType: string | null;
    main: {
      formattedAmount: string;
      amount: number;
      simplifiedPolicies: { cancellation: { code: string; label: string } };
      taxesTotalAmount: { included: ChargeDetailsData | null; excluded: ChargeDetailsData | null } | null;
      feesTotalAmount: { included: ChargeDetailsData | null; excluded: ChargeDetailsData | null } | null;
    };
    deduction: Array<{ percent: number; formattedAmount: string; type: string }> | null;
    alternative: { amount: number; formattedAmount: string } | null;
  };
  mealPlan: { code: string; label: string | null };
  lengthOfStay: { value: number; unit: string };
  rate: { id: string; label: string };
  accommodation: { code: string } | null;
}

// Pull the trailing numeric token out of a label like
// "Taxes excluded : ₹4,411.80" or "Taxes included : €191.91". Best-effort: if
// we can't confidently parse one (unusual locale, multiple numbers), return null.
function parseAmountFromLabel(label: string | null | undefined): number | null {
  if (!label) return null;
  const matches = label.match(/[\d][\d,.\s]*[\d]|[\d]/g);
  if (!matches || matches.length === 0) return null;
  const last = matches[matches.length - 1].replace(/\s/g, "");
  // Heuristic: en-style "1,234.56" — strip thousands commas; if no period,
  // commas could still be thousands (e.g. "4,411") so strip them too.
  const cleaned = last.includes(".") ? last.replace(/,/g, "") : last.replace(/[,]/g, "");
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

function toChargeSummary(c: ChargeDetailsData | null | undefined): ChargeSummary | null {
  if (!c || !c.label) return null;
  return {
    label: c.label,
    amount: parseAmountFromLabel(c.label),
    breakdown: Array.isArray(c.breakdown) ? c.breakdown : [],
  };
}

function formatCurrency(amount: number, sample: string, currency: string): string {
  // Try to mirror the symbol/format Accor returns. Sample looks like "₹24,510.00"
  // or "€1,643.05" — extract the leading non-digit prefix as the symbol.
  const symbolMatch = sample.match(/^[^\d-]+/);
  const symbol = symbolMatch ? symbolMatch[0] : `${currency} `;
  const rounded = Math.round(amount * 100) / 100;
  const hasDecimals = sample.includes(".");
  const num = hasDecimals
    ? rounded.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : Math.round(rounded).toLocaleString("en-US");
  return `${symbol}${num}`;
}

function buildPricingBreakdown(offer: OfferData | null): PricingBreakdown | null {
  if (!offer) return null;
  const p = offer.pricing;
  const taxesIncluded = toChargeSummary(p.main.taxesTotalAmount?.included);
  const taxesExcluded = toChargeSummary(p.main.taxesTotalAmount?.excluded);
  const feesIncluded = toChargeSummary(p.main.feesTotalAmount?.included);
  const feesExcluded = toChargeSummary(p.main.feesTotalAmount?.excluded);

  const excludedSum =
    (taxesExcluded?.amount ?? 0) + (feesExcluded?.amount ?? 0);
  const hasAnyExcluded =
    taxesExcluded?.amount != null || feesExcluded?.amount != null;
  const grandTotal = hasAnyExcluded ? p.main.amount + excludedSum : p.main.amount;
  const grandTotalFormatted = hasAnyExcluded
    ? formatCurrency(grandTotal, p.main.formattedAmount, p.currency)
    : p.main.formattedAmount;

  const allNull =
    !p.formattedTaxType && !taxesIncluded && !taxesExcluded && !feesIncluded && !feesExcluded;
  if (allNull) return null;

  return {
    taxType: p.formattedTaxType ?? null,
    taxesIncluded,
    taxesExcluded,
    feesIncluded,
    feesExcluded,
    grandTotal,
    grandTotalFormatted,
  };
}

interface HotelOffersData {
  hotelOffers: {
    offersSelection: { offers: OfferData[] };
    availability: { status: string; reasons: Array<{ code: string; label: string }> };
  };
}

async function fetchOneNight(
  hotelId: string,
  dateIn: string,
  currency: string,
  countryMarket: string,
  identificationToken?: string
): Promise<{ available: boolean; offers: OfferData[] }> {
  const dateOut = addDays(dateIn, 1);
  try {
    const data = await bffGql<HotelOffersData>(
      HOTEL_OFFERS_QUERY,
      mkVars(hotelId, dateIn, dateOut, 1, currency, countryMarket),
      "HotelPageHot",
      identificationToken
    );
    const { availability, offersSelection } = data.hotelOffers;
    return {
      available: availability.status === "AVAILABLE",
      offers: offersSelection.offers ?? [],
    };
  } catch {
    return { available: false, offers: [] };
  }
}

function bestRoomOnly(offers: OfferData[], accommodationCode?: string): OfferData | null {
  let roomOnly = offers.filter((o) => o.mealPlan.code === "EUROPEAN_PLAN");
  if (accommodationCode) {
    roomOnly = roomOnly.filter((o) => o.accommodation?.code === accommodationCode);
  }
  if (!roomOnly.length) return null;
  return roomOnly.reduce((a, b) => (a.pricing.main.amount < b.pricing.main.amount ? a : b));
}

async function fetchStrategy(
  label: string,
  hotelId: string,
  checkin: string,
  checkout: string,
  chunkDays: number, // 0 = single chunk (full stay)
  adults: number,
  currency: string,
  countryMarket: string,
  accommodationCode: string | undefined,
  identificationToken: string | undefined
): Promise<BookingStrategy> {
  const totalNights = nightCount(checkin, checkout);
  const chunkPlan: Array<{ dateIn: string; dateOut: string; nights: number }> = [];

  if (chunkDays === 0 || chunkDays >= totalNights) {
    chunkPlan.push({ dateIn: checkin, dateOut: checkout, nights: totalNights });
  } else {
    for (let s = 0; s < totalNights; s += chunkDays) {
      const n = Math.min(chunkDays, totalNights - s);
      chunkPlan.push({ dateIn: addDays(checkin, s), dateOut: addDays(checkin, s + n), nights: n });
    }
  }

  const chunks: ChunkResult[] = await Promise.all(
    chunkPlan.map(async (c): Promise<ChunkResult> => {
      try {
        const data = await bffGql<HotelOffersData>(
          HOTEL_OFFERS_QUERY,
          mkVars(hotelId, c.dateIn, c.dateOut, adults, currency, countryMarket),
          "HotelPageHot",
          identificationToken
        );
        const offers = data.hotelOffers.offersSelection.offers ?? [];
        const status = data.hotelOffers.availability.status;
        const reasons = data.hotelOffers.availability.reasons ?? [];
        const best = bestRoomOnly(offers, accommodationCode);
        const isAvail = status === "AVAILABLE" && !!best;
        const pricing = buildPricingBreakdown(best);
        return {
          dateIn: c.dateIn,
          dateOut: c.dateOut,
          nights: c.nights,
          available: isAvail,
          cheapestRoomOnlyTotal: best?.pricing.main.amount ?? null,
          cheapestRoomOnlyFormatted: best?.pricing.main.formattedAmount ?? null,
          cheapestRoomOnlyAllInTotal: pricing?.grandTotal ?? best?.pricing.main.amount ?? null,
          cheapestRoomOnlyAllInFormatted: pricing?.grandTotalFormatted ?? best?.pricing.main.formattedAmount ?? null,
          pricing,
          unavailabilityReason: !isAvail
            ? reasons.map((r) => r.label).join(" · ") || status
            : null,
        };
      } catch (err) {
        return {
          dateIn: c.dateIn,
          dateOut: c.dateOut,
          nights: c.nights,
          available: false,
          cheapestRoomOnlyTotal: null,
          cheapestRoomOnlyFormatted: null,
          cheapestRoomOnlyAllInTotal: null,
          cheapestRoomOnlyAllInFormatted: null,
          pricing: null,
          unavailabilityReason: err instanceof Error ? err.message : "fetch error",
        };
      }
    })
  );

  const allBookable = chunks.every((c) => c.available);
  const totalIfAllBookable = allBookable
    ? chunks.reduce((s, c) => s + (c.cheapestRoomOnlyTotal ?? 0), 0)
    : null;
  const totalAllInIfAllBookable = allBookable
    ? chunks.reduce((s, c) => s + (c.cheapestRoomOnlyAllInTotal ?? c.cheapestRoomOnlyTotal ?? 0), 0)
    : null;

  const chunkPattern = chunkPlan.map((c) => c.nights).join("+") + " nights";

  return { strategyLabel: label, chunkPattern, chunks, allBookable, totalIfAllBookable, totalAllInIfAllBookable };
}

export async function getHotelRates(opts: {
  hotelId: string;
  checkin: string;
  checkout: string;
  adults?: number;
  currency?: string;
  countryMarket?: string;
  memberCardNumber?: string;
  accommodationCode?: string;
}): Promise<HotelRatesSummary & { memberSummary: MemberSummary | null; accommodationCode: string | null }> {
  const {
    hotelId,
    checkin,
    checkout,
    adults = 1,
    currency = "INR",
    countryMarket = "IN",
    memberCardNumber,
    accommodationCode,
  } = opts;

  const nights = nightCount(checkin, checkout);
  if (nights < 1 || nights > 90) throw new Error("Date range must be 1–90 nights.");

  // If card number provided, bootstrap a token first to unlock personalised rates
  let identificationToken: string | undefined;
  let memberSummary: MemberSummary | null = null;
  if (memberCardNumber) {
    const result = await bootstrapMemberToken(memberCardNumber);
    identificationToken = result.token;
    memberSummary = result.summary;
  }

  // Build list of dates
  const dates = Array.from({ length: nights }, (_, i) => addDays(checkin, i));

  // Fetch all nights in parallel batches of 10
  const BATCH = 10;
  const nightlyResults: Array<{ date: string; available: boolean; offers: OfferData[] }> = [];

  for (let i = 0; i < dates.length; i += BATCH) {
    const batch = dates.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map((d) => fetchOneNight(hotelId, d, currency, countryMarket, identificationToken))
    );
    batch.forEach((d, j) => nightlyResults.push({ date: d, ...results[j] }));
  }

  // Also fetch full-stay options for package comparison
  let fullStayOptions: RateOption[] = [];
  try {
    const fullData = await bffGql<HotelOffersData>(
      HOTEL_OFFERS_QUERY,
      mkVars(hotelId, checkin, checkout, adults, currency, countryMarket),
      "HotelPageHot",
      identificationToken
    );
    let offers = fullData.hotelOffers.offersSelection.offers ?? [];
    if (accommodationCode) {
      offers = offers.filter((o) => o.accommodation?.code === accommodationCode);
    }
    // Deduplicate by meal plan + cancellation policy, take cheapest
    const seen = new Map<string, RateOption>();
    for (const o of offers) {
      const cancelCode = o.pricing.main.simplifiedPolicies.cancellation.code;
      const key = `${o.mealPlan.code}|${cancelCode}`;
      const total = o.pricing.main.amount;
      const deductions = o.pricing.deduction ?? [];
      const memberSaving = deductions.find((d) => d.type === "MEMBER_RATE")?.formattedAmount ?? null;
      const opt: RateOption = {
        rateLabel: o.rate.label,
        mealPlan: o.mealPlan.label ?? "Room only",
        totalAmount: total,
        totalFormatted: o.pricing.main.formattedAmount,
        perNight: total / nights,
        perNightFormatted: `${currency} ${(total / nights).toFixed(0)}`,
        cancellation: o.pricing.main.simplifiedPolicies.cancellation.label,
        memberSaving,
        nonMemberTotal: o.pricing.alternative?.amount ?? null,
        pricing: buildPricingBreakdown(o),
      };
      if (!seen.has(key) || seen.get(key)!.totalAmount > total) seen.set(key, opt);
    }
    fullStayOptions = [...seen.values()].sort((a, b) => a.totalAmount - b.totalAmount);
  } catch {
    // full-stay query failure is non-fatal
  }

  // Build nightly summary
  const nightly: NightlyRate[] = nightlyResults.map(({ date, available, offers }) => {
    const best = available ? bestRoomOnly(offers, accommodationCode) : null;
    const d = new Date(date + "T00:00:00Z");
    const memberSaving =
      best?.pricing.deduction?.find((x) => x.type === "MEMBER_RATE")?.formattedAmount ?? null;
    const breakdown = buildPricingBreakdown(best);
    // Compact one-liner so we don't repeat the full breakdown for each night.
    const taxNote =
      breakdown?.taxesExcluded?.label ??
      breakdown?.feesExcluded?.label ??
      breakdown?.taxType ??
      null;
    return {
      date,
      dayOfWeek: DAYS[d.getUTCDay()],
      available,
      roomOnlyPrice: best?.pricing.main.amount ?? null,
      roomOnlyFormatted: best?.pricing.main.formattedAmount ?? null,
      roomOnlyAllInPrice: breakdown?.grandTotal ?? best?.pricing.main.amount ?? null,
      roomOnlyAllInFormatted: breakdown?.grandTotalFormatted ?? best?.pricing.main.formattedAmount ?? null,
      taxNote,
      memberSaving,
    };
  });

  const prices = nightly.filter((n) => n.roomOnlyPrice !== null).map((n) => n.roomOnlyPrice!);
  const allInPrices = nightly
    .filter((n) => n.roomOnlyAllInPrice !== null)
    .map((n) => n.roomOnlyAllInPrice!);
  const roomOnlyStats =
    prices.length > 0
      ? {
          min: Math.min(...prices),
          max: Math.max(...prices),
          avg: prices.reduce((a, b) => a + b, 0) / prices.length,
          total: prices.reduce((a, b) => a + b, 0),
          allInTotal: allInPrices.length
            ? allInPrices.reduce((a, b) => a + b, 0)
            : prices.reduce((a, b) => a + b, 0),
          availableNights: prices.length,
          cheapestDay: nightly.find((n) => n.roomOnlyPrice === Math.min(...prices))!.date,
          mostExpensiveDay: nightly.find((n) => n.roomOnlyPrice === Math.max(...prices))!.date,
        }
      : null;

  // Fetch booking strategies in parallel — full stay vs 2-week vs 1-week chunks
  // Some Accor properties cap reservation length (often 28 nights), so chunked
  // alternatives reveal what's actually bookable. Skip strategies whose chunk
  // size matches/exceeds total nights (would duplicate full stay).
  const strategyTasks: Array<Promise<BookingStrategy>> = [
    fetchStrategy("Full stay", hotelId, checkin, checkout, 0, adults, currency, countryMarket, accommodationCode, identificationToken),
  ];
  if (nights > 14) {
    strategyTasks.push(
      fetchStrategy("2-week chunks", hotelId, checkin, checkout, 14, adults, currency, countryMarket, accommodationCode, identificationToken)
    );
  }
  if (nights > 7) {
    strategyTasks.push(
      fetchStrategy("1-week chunks", hotelId, checkin, checkout, 7, adults, currency, countryMarket, accommodationCode, identificationToken)
    );
  }
  const bookingStrategies = await Promise.all(strategyTasks);

  return {
    hotelId,
    currency,
    checkin,
    checkout,
    nights,
    nightly,
    roomOnlyStats,
    fullStayOptions,
    bookingStrategies,
    memberSummary,
    accommodationCode: accommodationCode ?? null,
  };
}

