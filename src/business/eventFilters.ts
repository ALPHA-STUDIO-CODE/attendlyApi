import type { Prisma } from "@prisma/client";

export interface EventListFilters {
  category?: string;
  city?: string;
  from?: string;
  to?: string;
  upcoming?: string;
  search?: string;
}

export function buildEventWhereClause(filters: EventListFilters): Prisma.EventWhereInput {
  const where: Prisma.EventWhereInput = {};

  if (filters.category) {
    where.categoryId = filters.category;
  }

  if (filters.city) {
    where.city = { contains: filters.city, mode: "insensitive" };
  }

  if (filters.search) {
    where.OR = [
      { title: { contains: filters.search, mode: "insensitive" } },
      { description: { contains: filters.search, mode: "insensitive" } },
    ];
  }

  const dateFilter: Prisma.DateTimeFilter = {};
  if (filters.from) {
    dateFilter.gte = new Date(filters.from);
  }
  if (filters.to) {
    dateFilter.lte = new Date(filters.to);
  }
  if (filters.upcoming === "true" || filters.upcoming === "1") {
    dateFilter.gte = dateFilter.gte && dateFilter.gte > new Date() ? dateFilter.gte : new Date();
  }
  if (Object.keys(dateFilter).length > 0) {
    where.date = dateFilter;
  }

  return where;
}
