import type { UnifiedSong } from '../../types';
import { calculateMatchScoreDetails } from '../../utils/lyrics/matchScore';
import type { MatchScoreDetails } from '../../utils/lyrics/matchScore';
import { buildLyricSearchQuery } from '../../utils/lyrics/searchQuery';
import type { ImportedTrack } from './exportifyCsv';

// src/services/playlistImport/matchImportedTracks.ts
// Resolves imported (e.g. Spotify) tracks to songs of one Folia provider by searching and scoring candidates.

export type TrackSearch = (query: string, signal?: AbortSignal) => Promise<UnifiedSong[]>;

// Same bar as automatic lyric matching (autoMatchBestLyric): below it a hit is likely another version.
const MATCH_MIN_SCORE = 75;
const SEARCH_RESULT_LIMIT = 10;
const DEFAULT_CONCURRENCY = 3;

export type TrackMatchStatus = 'matched' | 'uncertain' | 'unmatched' | 'failed';

export interface TrackMatch {
    track: ImportedTrack;
    status: TrackMatchStatus;
    /** Best reliable candidate for `matched` and `uncertain`; absent otherwise. */
    song?: UnifiedSong;
    score?: number;
    /** Search failures (auth, network, rate limit) are reported apart from "not found". */
    error?: string;
}

export interface MatchProgress {
    done: number;
    total: number;
}

export interface MatchOptions {
    signal?: AbortSignal;
    concurrency?: number;
    onProgress?: (progress: MatchProgress) => void;
}

const throwIfAborted = (signal?: AbortSignal) => {
    if (!signal?.aborted) return;
    const error = new Error('Playlist import was cancelled');
    error.name = 'AbortError';
    throw error;
};

const isReliable = (details: MatchScoreDetails): boolean => (
    details.titleMatched && (details.artistMatched || details.albumMatched === true)
);

// A full "title - artist - album" query can miss on providers that index fewer fields, so a bare
// "title artist" query is the second attempt.
const buildQueries = (track: ImportedTrack): string[] => {
    const artist = track.artists.join(', ');
    const full = buildLyricSearchQuery(track.title, artist, track.album);
    const short = [track.title, track.artists[0]].filter(Boolean).join(' ');
    return full === short ? [full] : [full, short];
};

const pickBest = (track: ImportedTrack, songs: UnifiedSong[]): { song: UnifiedSong; details: MatchScoreDetails } | null => {
    const target = {
        title: track.title,
        artist: track.artists.join(', '),
        album: track.album,
        durationMs: track.durationMs,
    };
    const scored = songs
        .slice(0, SEARCH_RESULT_LIMIT)
        .map(song => ({ song, details: calculateMatchScoreDetails(target, song) }))
        .filter(item => isReliable(item.details))
        .sort((a, b) => b.details.score - a.details.score);
    return scored[0] ?? null;
};

export const matchImportedTrack = async (
    track: ImportedTrack,
    search: TrackSearch,
    signal?: AbortSignal,
): Promise<TrackMatch> => {
    let best: ReturnType<typeof pickBest> = null;
    try {
        for (const query of buildQueries(track)) {
            throwIfAborted(signal);
            const candidate = pickBest(track, await search(query, signal));
            if (candidate && (!best || candidate.details.score > best.details.score)) best = candidate;
            if (best && best.details.score >= MATCH_MIN_SCORE) break;
        }
    } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') throw error;
        return { track, status: 'failed', error: error instanceof Error ? error.message : String(error) };
    }

    if (!best) return { track, status: 'unmatched' };
    return {
        track,
        status: best.details.score >= MATCH_MIN_SCORE ? 'matched' : 'uncertain',
        song: best.song,
        score: best.details.score,
    };
};

// Matches every track with bounded concurrency, keeping the result order equal to the input order.
export const matchImportedTracks = async (
    tracks: ImportedTrack[],
    search: TrackSearch,
    options: MatchOptions = {},
): Promise<TrackMatch[]> => {
    const { signal, onProgress } = options;
    const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
    const results = new Array<TrackMatch>(tracks.length);
    let next = 0;
    let done = 0;

    const worker = async () => {
        while (next < tracks.length) {
            throwIfAborted(signal);
            const index = next;
            next += 1;
            results[index] = await matchImportedTrack(tracks[index], search, signal);
            done += 1;
            onProgress?.({ done, total: tracks.length });
        }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, tracks.length) }, worker));
    return results;
};
