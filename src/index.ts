#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  searchHotels,
  searchSpecialRates,
  getHotelDetails,
} from "./accor-client.js";
import {
  getHotelRates,
  listHotelRooms,
  getHotelDetailsGql,
  type HotelGqlDetails,
  type HotelRatesSummary,
  type HotelRoom,
  type MemberSummary,
} from "./graphql-client.js";
import type { Hotel, HotelDetails, SpecialOffer } from "./types.js";

function createServer(): McpServer {
  const server = new McpServer({
    name: "accor-mcp",
    version: "1.0.0",
  });
  registerTools(server);
  return server;
}

function registerTools(server: McpServer): void {

// ── Tool 1: search_hotels ────────────────────────────────────────────────────

server.registerTool(
  "search_hotels",
  {
    title: "Search Accor Hotels",
    description:
      "Search for Accor hotels by destination. Returns a list of hotels with ratings, brand, star category, and booking URLs. Optionally filter by brand or star rating. Provide check-in/check-out dates to get direct booking links with availability. Set has_apartment=true to surface only hotels that actually have apartment-classified rooms (verified via HotelPageCold) — the Accor brand filter alone misses many properties (e.g. Mercure / Pullman / Mövenpick) that include 1BR+ apartment units.",
    inputSchema: z.object({
      destination: z
        .string()
        .describe('City or destination name, e.g. "Paris", "Tokyo", "Dubai"'),
      brand: z
        .string()
        .optional()
        .describe(
          'Filter by Accor brand, e.g. "Novotel", "ibis", "Pullman", "Mercure", "Sofitel", "Mgallery", "Fairmont"'
        ),
      stars: z
        .number()
        .int()
        .min(1)
        .max(5)
        .optional()
        .describe("Filter by star rating (1-5)"),
      has_apartment: z
        .boolean()
        .optional()
        .describe(
          "If true, only return hotels that actually have at least one APARTMENT-classified room (verified per-hotel via GraphQL). Useful for long stays where you want a real apartment with kitchen/laundry, not just a hotel suite. Slower than a plain Algolia search (N+1 calls)."
        ),
      checkin: z
        .string()
        .optional()
        .describe("Check-in date in YYYY-MM-DD format — enables direct booking links"),
      checkout: z
        .string()
        .optional()
        .describe("Check-out date in YYYY-MM-DD format"),
      adults: z
        .number()
        .int()
        .min(1)
        .max(9)
        .optional()
        .describe("Number of adults (default: 2)"),
      rooms: z
        .number()
        .int()
        .min(1)
        .max(7)
        .optional()
        .describe("Number of rooms (default: 1)"),
      hits_per_page: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe("Number of results to return (default: 10, max: 50)"),
    }),
  },
  async (input) => {
    try {
      const { hotels, total, apartmentFiltered } = await searchHotels({
        destination: input.destination,
        brand: input.brand,
        stars: input.stars,
        hitsPerPage: input.hits_per_page,
        checkin: input.checkin,
        checkout: input.checkout,
        adults: input.adults,
        rooms: input.rooms,
        hasApartment: input.has_apartment,
      });

      if (hotels.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No Accor hotels found for "${input.destination}"${input.brand ? ` with brand "${input.brand}"` : ""}${input.stars ? ` (${input.stars}★)` : ""}.`,
            },
          ],
        };
      }

      const header = [
        `Found ${total} Accor hotel${total !== 1 ? "s" : ""} for "${input.destination}"`,
        input.brand ? ` · ${input.brand}` : "",
        input.stars ? ` · ${input.stars}★` : "",
        apartmentFiltered ? " · 🏢 with apartments" : "",
        ` — showing ${hotels.length}:`,
      ].join("");

      const lines = [header, "", ...hotels.map(formatHotel)];
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error searching hotels: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

function formatHotel(h: Hotel, i: number): string {
  const n = i + 1;
  const stars = h.stars ? "★".repeat(h.stars) : "";
  const rating = h.ratingScore
    ? `⭐ ${h.ratingScore}/5${h.ratingCount ? ` (${h.ratingCount} reviews)` : ""}`
    : "";
  const badges = [
    h.hasMemberRate ? "🏅 Member rate" : "",
    h.isNewOpening ? "🆕 New opening" : "",
  ]
    .filter(Boolean)
    .join(" · ");

  const aptLine = h.apartmentRoomCodes && h.apartmentRoomCodes.length
    ? `   🏢 Apartment rooms: ${h.apartmentRoomCodes.slice(0, 4).join("; ")}${h.apartmentRoomCodes.length > 4 ? `; +${h.apartmentRoomCodes.length - 4} more` : ""}`
    : "";
  return [
    `${n}. **${h.name}** ${stars}`,
    `   ${h.brand ? `${h.brand} · ` : ""}${h.city}, ${h.country}`,
    rating ? `   ${rating}` : "",
    badges ? `   ${badges}` : "",
    aptLine,
    `   🔗 ${h.bookingUrl}`,
  ]
    .filter((l) => l.trim())
    .join("\n");
}

// ── Tool 2: get_hotel_details ─────────────────────────────────────────────────

server.registerTool(
  "get_hotel_details",
  {
    title: "Get Accor Hotel Details",
    description:
      "Get detailed information about a specific Accor hotel by its ID. Returns full address, GPS coordinates, star rating, guest score, free and paid amenities, description, and photo URLs. Hotel IDs come from search_hotels results. Optionally provide dates to get a direct booking link.",
    inputSchema: z.object({
      hotel_id: z
        .string()
        .describe(
          'Accor hotel ID (e.g. "9375", "3144"). Obtain this from search_hotels results.'
        ),
      checkin: z
        .string()
        .optional()
        .describe("Check-in date YYYY-MM-DD — adds a direct booking link"),
      checkout: z
        .string()
        .optional()
        .describe("Check-out date YYYY-MM-DD"),
      adults: z
        .number()
        .int()
        .min(1)
        .max(9)
        .optional()
        .describe("Number of adults (default: 2)"),
      rooms: z
        .number()
        .int()
        .min(1)
        .max(7)
        .optional()
        .describe("Number of rooms (default: 1)"),
    }),
  },
  async (input) => {
    try {
      const details = await getHotelDetails(input.hotel_id, {
        checkin: input.checkin,
        checkout: input.checkout,
        adults: input.adults,
        rooms: input.rooms,
      });
      return {
        content: [{ type: "text" as const, text: formatDetails(details) }],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error fetching hotel "${input.hotel_id}": ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

function formatDetails(d: HotelDetails): string {
  const lines: string[] = [`**${d.name}**`, `Hotel ID: ${d.id} · ${d.brand}`];

  const addr = [d.address.street, d.address.city, d.address.postalCode, d.address.country]
    .filter(Boolean)
    .join(", ");
  if (addr) lines.push(`📍 ${addr}`);

  if (d.coordinates) {
    lines.push(`🌐 ${d.coordinates.lat}, ${d.coordinates.lng}`);
  }

  const starStr = d.stars ? "★".repeat(d.stars) : null;
  if (starStr) lines.push(`Stars: ${starStr}`);

  if (d.ratingScore) {
    lines.push(
      `⭐ ${d.ratingScore}/5${d.ratingCount ? ` from ${d.ratingCount} reviews` : ""}`
    );
  }

  const badges = [
    d.hasMemberRate ? "🏅 Member rate available" : "",
    d.isNewOpening ? "🆕 New opening" : "",
  ]
    .filter(Boolean)
    .join(" · ");
  if (badges) lines.push(badges);

  if (d.description) lines.push("", d.description);
  if (d.enhancedDescription) lines.push("", d.enhancedDescription);

  if (d.freeAmenities.length > 0) {
    lines.push("", `✅ Free: ${d.freeAmenities.join(", ")}`);
  }
  if (d.paidAmenities.length > 0) {
    lines.push(`💳 Paid: ${d.paidAmenities.join(", ")}`);
  }

  if (d.thematics.length > 0) {
    lines.push(`🏷️  Tags: ${d.thematics.join(", ")}`);
  }

  if (d.images.length > 0) {
    lines.push("", `🖼️  ${d.images[0]}`);
  }

  lines.push("", `🔗 ${d.bookingUrl}`);
  return lines.join("\n");
}

// ── Tool 3: search_special_rates ──────────────────────────────────────────────

server.registerTool(
  "search_special_rates",
  {
    title: "Search Accor Special Rates & Deals",
    description:
      "Find Accor hotels by special category: newly-opened properties, highly-rated hotels (4.5+ guest score), luxury 5-star properties, or all open hotels. Optionally filter by destination or brand.",
    inputSchema: z.object({
      destination: z
        .string()
        .optional()
        .describe('City or destination to search in, e.g. "London". Leave empty for global results.'),
      brand: z
        .string()
        .optional()
        .describe('Filter by brand, e.g. "Novotel", "Sofitel", "ibis"'),
      rate_type: z
        .enum(["new_opening", "highly_rated", "luxury", "all"])
        .optional()
        .describe(
          '"new_opening" = newly opened hotels (default), "highly_rated" = 4.5+ guest score, "luxury" = 5-star properties, "all" = no extra filter'
        ),
      hits_per_page: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe("Number of results (default: 10)"),
    }),
  },
  async (input) => {
    try {
      const offers = await searchSpecialRates({
        destination: input.destination,
        brand: input.brand,
        rateType: input.rate_type,
        hitsPerPage: input.hits_per_page,
      });

      if (offers.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No special rate hotels found${input.destination ? ` in "${input.destination}"` : ""}${input.brand ? ` for brand "${input.brand}"` : ""}.`,
            },
          ],
        };
      }

      const label =
        input.rate_type === "new_opening"
          ? "New Opening"
          : input.rate_type === "highly_rated"
            ? "Highly Rated"
            : input.rate_type === "luxury"
              ? "Luxury (5★)"
              : "Open";

      const lines = [
        `Accor hotels with ${label} deals${input.destination ? ` in "${input.destination}"` : ""} (${offers.length} found):`,
        "",
        ...offers.map(formatOffer),
      ];

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error searching special rates: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

function formatOffer(o: SpecialOffer, i: number): string {
  const n = i + 1;
  const stars = o.stars ? "★".repeat(o.stars) : "";
  const rating = o.ratingScore ? `⭐ ${o.ratingScore}/5` : "";
  return [
    `${n}. **${o.hotelName}** ${stars}`,
    `   ${o.brand} · ${o.city}, ${o.country}`,
    rating ? `   ${rating}` : "",
    o.offerTypes.length ? `   🏷️  ${o.offerTypes.join(" · ")}` : "",
    `   🔗 ${o.bookingUrl}`,
  ]
    .filter((l) => l.trim())
    .join("\n");
}

// ── Tool 4: get_hotel_rates ───────────────────────────────────────────────────

server.registerTool(
  "get_hotel_rates",
  {
    title: "Get Accor Hotel Rates (day-by-day)",
    description:
      "Fetch live nightly pricing for an Accor hotel via the BFF GraphQL API. Returns day-by-day room-only rates plus full-stay package options (breakfast, half-board, early-bird, etc.). Defaults to INR with India market — pass currency/country_market for other markets. Optionally pass an ALL membership card number (no password needed — same flow as the homepage 'Just enter your card number' widget) to unlock tier-specific member rates.",
    inputSchema: z.object({
      hotel_id: z.string().describe('Accor hotel ID (e.g. "B1P9", "3537")'),
      checkin: z.string().describe("Check-in date YYYY-MM-DD"),
      checkout: z.string().describe("Check-out date YYYY-MM-DD"),
      adults: z
        .number()
        .int()
        .min(1)
        .max(9)
        .optional()
        .describe("Number of adults (default: 1)"),
      currency: z
        .string()
        .length(3)
        .optional()
        .describe('ISO 4217 currency code, e.g. "INR", "USD", "EUR", "AED" (default: "INR")'),
      country_market: z
        .string()
        .length(2)
        .optional()
        .describe('ISO 2-letter country code for market, e.g. "IN", "US", "AE" (default: "IN")'),
      member_card_number: z
        .string()
        .min(8)
        .optional()
        .describe(
          "Optional ALL Accor loyalty card number to unlock member-tier rates. Card number alone is sufficient — no password or login needed."
        ),
      accommodation_code: z
        .string()
        .optional()
        .describe(
          "Optional accommodation/room code (e.g. 'AR2P' for Adagio 1BR, 'AKC' for Mercure 1BR Apartment) to filter pricing to a specific room type. Use list_hotel_rooms to discover codes."
        ),
    }),
  },
  async (input) => {
    try {
      const summary = await getHotelRates({
        hotelId: input.hotel_id,
        checkin: input.checkin,
        checkout: input.checkout,
        adults: input.adults,
        currency: input.currency,
        countryMarket: input.country_market,
        memberCardNumber: input.member_card_number,
        accommodationCode: input.accommodation_code,
      });
      return { content: [{ type: "text" as const, text: formatRates(summary) }] };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error fetching rates for hotel "${input.hotel_id}": ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

function formatRates(s: HotelRatesSummary & { memberSummary: MemberSummary | null; accommodationCode: string | null }): string {
  const lines: string[] = [];
  lines.push(`**Rates for hotel ${s.hotelId}**  (${s.currency})`);
  lines.push(`${s.checkin} → ${s.checkout}  ·  ${s.nights} nights`);
  if (s.accommodationCode) lines.push(`Filtered to room code: \`${s.accommodationCode}\``);

  if (s.memberSummary) {
    lines.push("");
    lines.push(formatMemberSummary(s.memberSummary));
  }

  lines.push("");

  // Day-by-day table
  if (s.nightly.length > 0) {
    lines.push("📅 **Nightly room-only rates** (member rate, cheapest available)");
    lines.push("```");
    lines.push("Date         Day   Price          Saving");
    lines.push("─".repeat(48));
    for (const n of s.nightly) {
      const weekend = n.dayOfWeek === "Fri" || n.dayOfWeek === "Sat" ? " ◀" : "";
      const price = n.roomOnlyFormatted ?? "  unavail";
      const saving = n.memberSaving ? `(save ${n.memberSaving})` : "";
      lines.push(`${n.date}  ${n.dayOfWeek}   ${price.padStart(12)}  ${saving}${weekend}`);
    }
    lines.push("```");
  }

  // Stats
  if (s.roomOnlyStats) {
    const st = s.roomOnlyStats;
    const variance = ((st.max - st.min) / st.min) * 100;
    lines.push("");
    lines.push("📊 **Stats** (room-only, member rate)");
    lines.push(`  Cheapest:     ${s.currency} ${st.min.toLocaleString()} on ${st.cheapestDay}`);
    lines.push(`  Most expensive: ${s.currency} ${st.max.toLocaleString()} on ${st.mostExpensiveDay}`);
    lines.push(`  Average/night: ${s.currency} ${Math.round(st.avg).toLocaleString()}`);
    lines.push(`  Variance: ${variance.toFixed(1)}%  (${variance < 25 ? "very stable" : variance < 50 ? "moderate swing" : "high swing"})`);
    lines.push(`  Total: ${s.currency} ${Math.round(st.total).toLocaleString()}  (${st.availableNights}/${s.nights} nights priced)`);
  } else {
    lines.push("");
    lines.push("⚠️  No room-only nightly rates available for this period.");
  }

  // Full-stay options
  if (s.fullStayOptions.length > 0) {
    lines.push("");
    lines.push(`📦 **Full-stay package options** (${s.nights} nights)`);
    for (const o of s.fullStayOptions.slice(0, 8)) {
      lines.push(
        `  • ${o.mealPlan} · ${o.cancellation}  →  ${o.totalFormatted} total  (${o.perNightFormatted}/night)`
      );
      lines.push(`     ↳ ${o.rateLabel}${o.memberSaving ? ` · save ${o.memberSaving} as member` : ""}`);
    }
  }

  // Booking strategies (chunking fallbacks)
  if (s.bookingStrategies.length > 0) {
    lines.push("");
    lines.push("🗓️  **Booking strategies** — some hotels cap stay length, so we test multiple chunkings");
    let cheapest: { label: string; total: number } | null = null;
    for (const st of s.bookingStrategies) {
      const status = st.allBookable ? "✅" : "❌";
      const total = st.totalIfAllBookable !== null
        ? `${s.currency} ${Math.round(st.totalIfAllBookable).toLocaleString()}`
        : "n/a";
      const reservations = `${st.chunks.length} reservation${st.chunks.length !== 1 ? "s" : ""}`;
      lines.push(`  ${status} ${st.strategyLabel} (${st.chunkPattern} · ${reservations}):  ${total}`);
      if (st.allBookable && st.totalIfAllBookable !== null) {
        if (!cheapest || st.totalIfAllBookable < cheapest.total) {
          cheapest = { label: st.strategyLabel, total: st.totalIfAllBookable };
        }
      }
      // Show per-chunk detail if any chunk failed (so user knows where the gap is)
      if (!st.allBookable) {
        for (const c of st.chunks) {
          const chunkStatus = c.available ? "✅" : "❌";
          const price = c.cheapestRoomOnlyFormatted ?? (c.unavailabilityReason ?? "unavailable");
          lines.push(`     ${chunkStatus} ${c.dateIn} → ${c.dateOut} (${c.nights}n): ${price}`);
        }
      }
    }
    if (cheapest) {
      lines.push("");
      lines.push(`  💡 Cheapest fully-bookable strategy: **${cheapest.label}** at ${s.currency} ${Math.round(cheapest.total).toLocaleString()}`);
    } else {
      lines.push("");
      lines.push(`  ⚠️  No booking strategy is fully bookable — the property may have availability gaps`);
    }
  }

  return lines.join("\n");
}

// ── Tool 5: get_hotel_details_graphql ────────────────────────────────────────

server.registerTool(
  "get_hotel_details_graphql",
  {
    title: "Get Rich Hotel Details (GraphQL BFF)",
    description:
      "Fetch a deep, freshly-rendered detail payload for an Accor hotel via the BFF GraphQL API (HotelPageCold operation). Heavier than `get_hotel_details` (Algolia) but returns: brand description, GM welcome message, full advantages/USP list, top amenities, amenity categories, certifications (eco labels, etc.), loyalty programme participation, formatted check-in/out times, room-occupancy limits, accepted payment methods, presentation kickers/badges, marketing labels, full facilities catalog (breakfasts, fitness centres, pools, restaurants, bars, spas — each with name + description), connecting/family room availability, recent guest reviews (author, rating, title, text, trip type), media gallery (image URLs by category), AND the full accommodation/room catalog. Use this when you need rich descriptive content; use `get_hotel_details` for fast, lightweight lookups.",
    inputSchema: z.object({
      hotel_id: z.string().describe('Accor hotel ID (e.g. "9221", "A8V6", "B1P9")'),
    }),
  },
  async (input) => {
    try {
      const d = await getHotelDetailsGql(input.hotel_id);
      return { content: [{ type: "text" as const, text: formatGqlDetails(d) }] };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error fetching GraphQL details for "${input.hotel_id}": ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

function formatGqlDetails(d: HotelGqlDetails): string {
  const lines: string[] = [];
  lines.push(`**${d.name}**`);
  lines.push(`Hotel ID: ${d.id} · ${d.brand.label} (${d.brand.code})`);

  const addr = [d.address.street, d.address.city, d.address.zipCode, d.address.country]
    .filter(Boolean).join(", ");
  if (addr) lines.push(`📍 ${addr}`);
  if (d.coordinates) lines.push(`🌐 ${d.coordinates.lat}, ${d.coordinates.lng}`);
  if (d.contact.phone) lines.push(`📞 ${d.contact.phone}`);
  if (d.contact.email) lines.push(`✉️  ${d.contact.email}`);

  if (d.rating.stars || d.rating.score) {
    const stars = d.rating.stars ? "★".repeat(d.rating.stars) : "";
    const score = d.rating.score ? ` · ⭐ ${d.rating.score}/5` : "";
    const reviews = d.rating.numberOfReviews ? ` (${d.rating.numberOfReviews} reviews${d.rating.origin ? ` from ${d.rating.origin}` : ""})` : "";
    lines.push(`${stars}${score}${reviews}`);
  }

  if (d.formattedCheckIn || d.formattedCheckOut) {
    lines.push(`🕒 Check-in: ${d.formattedCheckIn ?? "?"}  ·  Check-out: ${d.formattedCheckOut ?? "?"}`);
  }

  if (d.flashInfo) lines.push("", `⚡ **Flash info:** ${d.flashInfo}`);

  if (d.presentationKickers.length) {
    lines.push("", `🏷️  ${d.presentationKickers.join(" · ")}`);
  }

  if (d.description?.general) {
    lines.push("", "**About**");
    lines.push(stripHtml(d.description.general));
  }
  if (d.description?.destination) {
    lines.push("", "**Destination**");
    lines.push(stripHtml(d.description.destination));
  }

  if (d.managerMessage) {
    lines.push("", `**A note from ${d.managerMessage.firstName} ${d.managerMessage.lastName}** (General Manager)`);
    lines.push(stripHtml(d.managerMessage.message));
  }

  if (d.advantages.length) {
    lines.push("", "✅ **Hotel advantages**");
    for (const a of d.advantages) lines.push(`  • ${a}`);
  }

  if (d.topAmenities.length) {
    lines.push("", `🏨 **Top amenities:** ${d.topAmenities.join(" · ")}`);
  }

  if (d.amenityCategories.length) {
    lines.push(`📋 **Amenity categories:** ${d.amenityCategories.join(", ")}`);
  }

  if (d.certifications.length) {
    lines.push("", "🌱 **Certifications**");
    for (const c of d.certifications) lines.push(`  • ${c.label}${c.description ? ` — ${stripHtml(c.description)}` : ""}`);
  }

  if (d.labels.length) {
    lines.push("", `🏷️  **Labels:** ${d.labels.join(", ")}`);
  }

  if (d.loyaltyProgram) {
    lines.push("", `🎫 **Loyalty:** ${d.loyaltyProgram.status}${d.loyaltyProgram.burnAllowed ? " · points redemption allowed" : ""}`);
  }

  if (d.roomOccupancy) {
    const r = d.roomOccupancy;
    lines.push("", `👥 **Room occupancy limits:** max ${r.maxAdult} adults · ${r.maxChild} children · ${r.maxPax} pax · ${r.maxRoom} rooms`);
  }

  if (d.amenitiesInventory) {
    const a = d.amenitiesInventory;
    const flags: string[] = [];
    if (a.connectingRooms) flags.push("connecting rooms");
    if (a.familyRooms) flags.push("family rooms");
    if (flags.length) lines.push(`🛏️  Inventory: ${flags.join(" · ")}`);
  }

  if (d.paymentMeans.length) {
    lines.push("", `💳 **Payment accepted:** ${d.paymentMeans.join(", ")}`);
  }

  // Facilities
  const f = d.facilities;
  const facilityLines: string[] = [];
  const renderFacility = (label: string, items: typeof f.breakfasts) => {
    if (!items.length) return;
    facilityLines.push(`  ${label}:`);
    for (const it of items) {
      facilityLines.push(`    • ${it.name}${it.description ? ` — ${stripHtml(it.description).slice(0, 120)}` : ""}`);
    }
  };
  renderFacility("☕ Breakfast", f.breakfasts);
  renderFacility("🍽️  Restaurants", f.restaurants);
  renderFacility("🍸 Bars", f.bars);
  renderFacility("🏊 Pools", f.pools);
  renderFacility("💪 Fitness centres", f.fitnessCenters);
  renderFacility("🧖 Spas", f.spas);
  if (facilityLines.length) {
    lines.push("", "**Facilities**", ...facilityLines);
  }

  // Reviews
  if (d.rating.reviews.length) {
    lines.push("", `**Recent reviews** (${d.rating.reviews.length} of ${d.rating.numberOfReviews ?? "?"})`);
    for (const r of d.rating.reviews) {
      const meta = [r.rating ? `⭐ ${r.rating}/5` : "", r.tripType, r.date].filter(Boolean).join(" · ");
      lines.push(`  • ${r.title ? `**${r.title}** — ` : ""}${meta}`);
      lines.push(`    "${r.text.slice(0, 250)}${r.text.length > 250 ? "…" : ""}"  — ${r.author}`);
    }
  }

  // Accommodations summary
  if (d.accommodations.length) {
    lines.push("", `**Accommodations** (${d.accommodations.length} room types — use \`list_hotel_rooms\` for full detail)`);
    for (const a of d.accommodations) {
      const size = a.surfaceSquareMeter ? `${a.surfaceSquareMeter} m²` : "";
      lines.push(`  • \`${a.code}\` — ${a.name}  ${size ? `(${size})` : ""}`);
    }
  }

  // Media gallery
  if (d.mediaItems.length) {
    lines.push("", `**Media** (${d.totalMedias} total · ${d.totalVideos} videos · showing ${d.mediaItems.length})`);
    for (const m of d.mediaItems) {
      if (m.url) lines.push(`  🖼️  ${m.category}: ${m.url}`);
    }
  }

  return lines.join("\n");
}

function stripHtml(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .trim();
}

// ── Tool 6: list_hotel_rooms ──────────────────────────────────────────────────

server.registerTool(
  "list_hotel_rooms",
  {
    title: "List Hotel Room Types",
    description:
      "Return the full accommodation/room catalog for an Accor hotel — codes, names, sizes (m²), max occupancy, bedding, classification (room/suite/apartment), and key features. Use the returned codes with get_hotel_rates' accommodation_code parameter to filter pricing to a specific room type (e.g. 1BR apartment vs studio).",
    inputSchema: z.object({
      hotel_id: z.string().describe('Accor hotel ID (e.g. "B1P9", "9221", "A8V6")'),
    }),
  },
  async (input) => {
    try {
      const rooms = await listHotelRooms(input.hotel_id);
      return { content: [{ type: "text" as const, text: formatRooms(input.hotel_id, rooms) }] };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error listing rooms for "${input.hotel_id}": ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

function formatRooms(hotelId: string, rooms: HotelRoom[]): string {
  const lines: string[] = [`**Room types for hotel ${hotelId}**  (${rooms.length} accommodations)`, ""];
  for (const r of rooms) {
    const size = r.surfaceSquareMeter ? `${r.surfaceSquareMeter} m²` : "size?";
    const occ = r.maxOccupancy ? `${r.maxOccupancy} pax` : "?";
    lines.push(`📦 \`${r.code}\` — ${r.name}`);
    lines.push(`   ${r.classificationStandard} ${r.classificationType} · ${size} · max ${occ}`);
    if (r.bedding) lines.push(`   🛏️  ${r.bedding}`);
    if (r.features.length) lines.push(`   ✨ ${r.features.slice(0, 6).join(" · ")}`);
    if (r.isAccessible) lines.push(`   ♿ Accessible`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

function formatMemberSummary(m: MemberSummary): string {
  const lines: string[] = [];
  lines.push("🪪 **ALL Membership card recognised**");
  const flags: string[] = [];
  if (m.isLoyaltyMember) flags.push("ALL Loyalty");
  if (m.isLcahMember) flags.push("LCAH");
  if (flags.length) lines.push(`   Status: ${flags.join(" · ")}  ·  ${m.b2bType}`);

  for (const c of m.cards) {
    const expiry = c.expirationDate ? `  expires ${c.expirationDate}` : "";
    lines.push(`   • ${c.kind === "SUBSCRIPTION" ? "🎫 " : "💳 "}${c.kind}  card ${c.number}  type ${c.type}${expiry}`);
  }

  if (m.tokenExpiresAt) {
    const minsLeft = Math.round((new Date(m.tokenExpiresAt).getTime() - Date.now()) / 60000);
    lines.push(`   Session token valid for ~${minsLeft} min`);
  }
  return lines.join("\n");
}

} // end of registerTools

// ── Transports: stdio (default) and Streamable HTTP ──────────────────────────

async function runStdio(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Accor MCP running on stdio");
}

async function runHttp(): Promise<void> {
  const port = parseInt(process.env.PORT ?? "3000", 10);
  const host = process.env.HOST ?? "0.0.0.0";
  const app = express();

  app.use(express.json({ limit: "4mb" }));

  // CORS — allow any origin for now (this is read-only, public-data only)
  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", req.headers.origin ?? "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Mcp-Session-Id, mcp-session-id, Authorization, Accept",
    );
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id, mcp-session-id");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });

  // Per-session transport map (Streamable HTTP is stateful)
  const transports = new Map<string, StreamableHTTPServerTransport>();

  app.post("/mcp", async (req: Request, res: Response) => {
    const sessionId =
      (req.headers["mcp-session-id"] as string | undefined) ??
      (req.headers["Mcp-Session-Id"] as string | undefined);
    let transport = sessionId ? transports.get(sessionId) : undefined;

    if (!transport) {
      // New session — create transport + dedicated MCP server instance
      const newTransport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          transports.set(sid, newTransport);
        },
      });
      newTransport.onclose = () => {
        if (newTransport.sessionId) transports.delete(newTransport.sessionId);
      };
      const server = createServer();
      await server.connect(newTransport);
      transport = newTransport;
    }

    await transport.handleRequest(req, res, req.body);
  });

  // GET — long-lived SSE notifications channel
  app.get("/mcp", async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const transport = sessionId ? transports.get(sessionId) : undefined;
    if (!transport) {
      res.status(404).json({ error: "session not found" });
      return;
    }
    await transport.handleRequest(req, res);
  });

  // DELETE — explicit session teardown
  app.delete("/mcp", async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const transport = sessionId ? transports.get(sessionId) : undefined;
    if (transport) {
      transports.delete(sessionId!);
      await transport.close();
    }
    res.status(204).end();
  });

  // Health check (handy for Railway/Render/Fly probes)
  app.get("/health", (_req: Request, res: Response) => {
    res.json({
      status: "ok",
      transport: "streamable-http",
      activeSessions: transports.size,
      version: "1.0.0",
    });
  });

  // Friendly index
  app.get("/", (_req: Request, res: Response) => {
    res.type("text/plain").send(
      "Accor MCP server (Streamable HTTP transport)\n\n" +
      "POST /mcp     — initialise + JSON-RPC requests\n" +
      "GET  /mcp     — SSE event stream (requires mcp-session-id)\n" +
      "DELETE /mcp   — close a session\n" +
      "GET  /health  — health check\n\n" +
      "See https://github.com/<you>/accor-mcp for usage.\n"
    );
  });

  app.listen(port, host, () => {
    console.error(`Accor MCP running on http://${host}:${port}/mcp`);
  });
}

const mode = (process.env.MCP_TRANSPORT ?? "stdio").toLowerCase();
if (mode === "http" || mode === "streamable-http") {
  await runHttp();
} else {
  await runStdio();
}
