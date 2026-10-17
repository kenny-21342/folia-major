// src/services/playlistImport/exportifyCsv.ts
// Parses Exportify-style Spotify CSV exports (playlists, Liked Songs, Saved Albums) into provider-neutral tracks.

export interface ImportedTrack {
    title: string;
    artists: string[];
    album: string;
    durationMs: number;
    isrc?: string;
    /** Identity in the exporting service, e.g. `spotify:track:...`. Never a Folia provider id. */
    sourceUri?: string;
    explicit: boolean;
    addedAt?: number;
}

export interface ParsedTrackList {
    name: string;
    tracks: ImportedTrack[];
    /** Rows that had no usable title, so nothing could be searched for them. */
    skippedRows: number;
}

// Splits CSV text into rows of cells. Handles quoted cells with "" escapes, embedded newlines, CRLF and a BOM.
const parseCsvRows = (text: string): string[][] => {
    const rows: string[][] = [];
    let row: string[] = [];
    let cell = '';
    let inQuotes = false;

    const endCell = () => {
        row.push(cell);
        cell = '';
    };
    const endRow = () => {
        endCell();
        // A trailing newline leaves one empty row behind; real blank lines carry no data either.
        if (row.length > 1 || row[0] !== '') rows.push(row);
        row = [];
    };

    const source = text.replace(/^﻿/, '');
    for (let i = 0; i < source.length; i += 1) {
        const char = source[i];
        if (inQuotes) {
            if (char === '"') {
                if (source[i + 1] === '"') {
                    cell += '"';
                    i += 1;
                } else {
                    inQuotes = false;
                }
            } else {
                cell += char;
            }
            continue;
        }
        if (char === '"') inQuotes = true;
        else if (char === ',') endCell();
        else if (char === '\n') endRow();
        else if (char !== '\r') cell += char;
    }
    if (cell !== '' || row.length > 0) endRow();
    return rows;
};

const HEADER_ALIASES = {
    title: ['track name', 'name', 'title'],
    artists: ['artist name(s)', 'artist names', 'artist name', 'artist', 'artists'],
    album: ['album name', 'album'],
    duration: ['duration (ms)', 'duration_ms', 'duration ms'],
    isrc: ['isrc'],
    uri: ['track uri', 'uri'],
    explicit: ['explicit'],
    addedAt: ['added at', 'added_at'],
} as const;

const findColumn = (header: string[], aliases: readonly string[]): number => {
    const normalized = header.map(cell => cell.trim().toLowerCase());
    return normalized.findIndex(cell => aliases.includes(cell));
};

// "Horizon_Pulse_-_Forza_Horizon_5.csv" -> "Horizon Pulse - Forza Horizon 5"
export const deriveListNameFromFileName = (fileName: string): string => (
    fileName
        .replace(/^.*[\\/]/, '')
        .replace(/\.csv$/i, '')
        .replace(/_/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
);

export const parseExportifyCsv = (text: string, fileName = ''): ParsedTrackList => {
    const rows = parseCsvRows(text);
    const name = deriveListNameFromFileName(fileName);
    if (rows.length === 0) return { name, tracks: [], skippedRows: 0 };

    const [header, ...body] = rows;
    const columns = {
        title: findColumn(header, HEADER_ALIASES.title),
        artists: findColumn(header, HEADER_ALIASES.artists),
        album: findColumn(header, HEADER_ALIASES.album),
        duration: findColumn(header, HEADER_ALIASES.duration),
        isrc: findColumn(header, HEADER_ALIASES.isrc),
        uri: findColumn(header, HEADER_ALIASES.uri),
        explicit: findColumn(header, HEADER_ALIASES.explicit),
        addedAt: findColumn(header, HEADER_ALIASES.addedAt),
    };
    if (columns.title < 0) return { name, tracks: [], skippedRows: body.length };

    const read = (row: string[], index: number): string => (index >= 0 ? (row[index] ?? '').trim() : '');
    const tracks: ImportedTrack[] = [];
    let skippedRows = 0;

    body.forEach(row => {
        const title = read(row, columns.title);
        if (!title) {
            skippedRows += 1;
            return;
        }
        const duration = Number(read(row, columns.duration));
        const addedAt = Date.parse(read(row, columns.addedAt));
        tracks.push({
            title,
            // Exportify joins multiple artists with ";".
            artists: read(row, columns.artists).split(';').map(artist => artist.trim()).filter(Boolean),
            album: read(row, columns.album),
            durationMs: Number.isFinite(duration) && duration > 0 ? duration : 0,
            isrc: read(row, columns.isrc) || undefined,
            sourceUri: read(row, columns.uri) || undefined,
            explicit: read(row, columns.explicit).toLowerCase() === 'true',
            addedAt: Number.isFinite(addedAt) ? addedAt : undefined,
        });
    });

    return { name, tracks, skippedRows };
};

// The same recording often appears in several lists (and under several URIs); ISRC identifies the recording.
const getTrackIdentity = (track: ImportedTrack): string => (
    track.isrc ? `isrc:${track.isrc.toUpperCase()}` : track.sourceUri ? `uri:${track.sourceUri}` : `text:${track.title}|${track.artists.join(',')}`
);

export const dedupeImportedTracks = (tracks: ImportedTrack[]): ImportedTrack[] => {
    const seen = new Set<string>();
    return tracks.filter(track => {
        const identity = getTrackIdentity(track);
        if (seen.has(identity)) return false;
        seen.add(identity);
        return true;
    });
};
