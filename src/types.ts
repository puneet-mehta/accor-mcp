export interface Hotel {
  id: string;
  name: string;
  brand: string;
  city: string;
  country: string;
  stars: number;
  ratingScore: number | null;
  ratingCount: number | null;
  labels: string[];
  isNewOpening: boolean;
  hasMemberRate: boolean;
  bookingUrl: string;
  apartmentRoomCodes?: string[];
}

export interface HotelDetails {
  id: string;
  name: string;
  brand: string;
  address: {
    street: string;
    city: string;
    postalCode: string;
    country: string;
    countryCode: string;
  };
  coordinates: { lat: number; lng: number } | null;
  stars: number | null;
  ratingScore: number | null;
  ratingCount: number | null;
  freeAmenities: string[];
  paidAmenities: string[];
  images: string[];
  description: string | null;
  enhancedDescription: string | null;
  labels: string[];
  thematics: string[];
  isNewOpening: boolean;
  hasMemberRate: boolean;
  bookingUrl: string;
}

export interface SpecialOffer {
  hotelId: string;
  hotelName: string;
  brand: string;
  city: string;
  country: string;
  stars: number;
  ratingScore: number | null;
  offerTypes: string[];
  bookingUrl: string;
}

export interface AlgoliaHit {
  objectID: string;
  name?: string;
  brandLabel?: string;
  brand?: string;
  city?: string;
  country?: string;
  stars?: number;
  rating?: unknown;
  localization?: unknown;
  freeAmenities?: unknown;
  paidAmenities?: unknown;
  mediaCatalog?: unknown;
  medias?: unknown;
  description?: string;
  enhancedDescription?: string;
  labels?: unknown;
  isNewOpening?: boolean;
  isLoyaltyProgramParticipating?: boolean;
  loyaltyProgram?: unknown;
  status?: string;
  thematics?: unknown;
  [key: string]: unknown;
}

export interface AlgoliaResponse {
  hits: AlgoliaHit[];
  nbHits: number;
  page: number;
  nbPages: number;
}
