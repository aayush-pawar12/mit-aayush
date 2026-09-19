import { eq, asc, and, inArray } from 'drizzle-orm';
import type { Database } from './db';
import { games, categories, publishers } from '../../db/schema';
import type { Game } from '../types/game';

export interface GameFilters {
    categories?: number[];
    publishers?: number[];
}

const gameSelection = {
    id: games.id,
    title: games.title,
    description: games.description,
    starRating: games.starRating,
    categoryId: categories.id,
    categoryName: categories.name,
    publisherId: publishers.id,
    publisherName: publishers.name,
};

type GameSelectionRow = {
    id: number;
    title: string;
    description: string;
    starRating: number | null;
    categoryId: number | null;
    categoryName: string | null;
    publisherId: number | null;
    publisherName: string | null;
};

function mapGame(row: GameSelectionRow): Game {
    return {
        id: row.id,
        title: row.title,
        description: row.description,
        starRating: row.starRating,
        category:
            row.categoryId !== null && row.categoryName !== null
                ? { id: row.categoryId, name: row.categoryName }
                : null,
        publisher:
            row.publisherId !== null && row.publisherName !== null
                ? { id: row.publisherId, name: row.publisherName }
                : null,
    };
}

function baseGamesQuery(db: Database, filters: GameFilters = {}) {
    const conditions = [];

    if (filters.categories && filters.categories.length > 0) {
        conditions.push(inArray(games.categoryId, filters.categories));
    }

    if (filters.publishers && filters.publishers.length > 0) {
        conditions.push(inArray(games.publisherId, filters.publishers));
    }

    const query = db
        .select(gameSelection)
        .from(games)
        .leftJoin(categories, eq(games.categoryId, categories.id))
        .leftJoin(publishers, eq(games.publisherId, publishers.id));

    return conditions.length > 0 ? query.where(and(...conditions)) : query;
}

/** All games ordered by title, optionally filtered by category and publisher IDs. */
export async function getAllGames(db: Database, filters: GameFilters = {}): Promise<Game[]> {
    const rows = await baseGamesQuery(db, filters).orderBy(asc(games.title));
    return rows.map(mapGame);
}

/** All game ids ordered by title, optionally filtered by category and publisher IDs. */
export async function getAllGameIds(db: Database, filters: GameFilters = {}): Promise<number[]> {
    const query = db.select({ id: games.id }).from(games);
    const conditions = [];

    if (filters.categories && filters.categories.length > 0) {
        conditions.push(inArray(games.categoryId, filters.categories));
    }

    if (filters.publishers && filters.publishers.length > 0) {
        conditions.push(inArray(games.publisherId, filters.publishers));
    }

    const rows = await (conditions.length > 0 ? query.where(and(...conditions)) : query).orderBy(asc(games.title));
    return rows.map((row) => row.id);
}

/** A single game by id, or null when it does not exist. */
export async function getGameById(db: Database, id: number): Promise<Game | null> {
    const row = await db
        .select(gameSelection)
        .from(games)
        .leftJoin(categories, eq(games.categoryId, categories.id))
        .leftJoin(publishers, eq(games.publisherId, publishers.id))
        .where(eq(games.id, id))
        .get();
    return row ? mapGame(row) : null;
}

/** All unique categories in the catalog, ordered by name for filter controls. */
export async function getAllCategories(db: Database): Promise<{ id: number; name: string }[]> {
    const rows = await db
        .select({ id: categories.id, name: categories.name })
        .from(categories)
        .orderBy(asc(categories.name));
    return rows;
}

/** All unique publishers in the catalog, ordered by name for filter controls. */
export async function getAllPublishers(db: Database): Promise<{ id: number; name: string }[]> {
    const rows = await db
        .select({ id: publishers.id, name: publishers.name })
        .from(publishers)
        .orderBy(asc(publishers.name));
    return rows;
}
