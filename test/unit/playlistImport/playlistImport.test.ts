import { describe, expect, it } from 'vitest';
import type { UnifiedSong } from '@/types';
import {
    dedupeImportedTracks,
    deriveListNameFromFileName,
    parseExportifyCsv,
} from '@/services/playlistImport/exportifyCsv';
import { matchImportedTrack, matchImportedTracks } from '@/services/playlistImport/matchImportedTracks';
import type { TrackSearch } from '@/services/playlistImport/matchImportedTracks';

// test/unit/playlistImport/playlistImport.test.ts
// Exportify CSV parsing and track matching, driven by synthetic rows and a fake search (no network).

const HEADER = 'Track URI,ISRC,Track Name,Album Name,Artist Name(s),Release Date,Duration (ms),Popularity,Explicit,Added By,Added At';

const csv = (...rows: string[]) => [HEADER, ...rows].join('\n');

const song = (name: string, artists: string[], album: string, durationMs: number): UnifiedSong => ({
    id: `${name}-${artists[0]}`,
    name,
    artists: artists.map((artist, index) => ({ id: index, name: artist })),
    album: { id: 1, name: album },
    durationMs,
    sourceRef: { kind: 'online', providerId: 'netease', mediaId: name },
});

describe('parseExportifyCsv', () => {
    it('reads quoted cells, ";" separated artists and commas inside titles', () => {
        const parsed = parseExportifyCsv(csv(
            'spotify:track:a,GB1,"Hello, World","Some ""Album""","A;B",2020,200000,50,true,u,2021-10-12T16:40:31Z',
        ), 'My_List_-_Two.csv');

        expect(parsed.name).toBe('My List - Two');
        expect(parsed.tracks).toEqual([{
            title: 'Hello, World',
            artists: ['A', 'B'],
            album: 'Some "Album"',
            durationMs: 200000,
            isrc: 'GB1',
            sourceUri: 'spotify:track:a',
            explicit: true,
            addedAt: Date.parse('2021-10-12T16:40:31Z'),
        }]);
    });

    it('survives a BOM, CRLF line endings and a newline inside a quoted cell', () => {
        const text = `\uFEFF${HEADER}\r\nspotify:track:a,GB1,"Two\nLines",Alb,Art,2020,1000,0,false,u,2021-01-01T00:00:00Z\r\n`;
        const parsed = parseExportifyCsv(text);
        expect(parsed.tracks).toHaveLength(1);
        expect(parsed.tracks[0].title).toBe('Two\nLines');
    });

    it('counts rows without a title as skipped and returns nothing without a title column', () => {
        expect(parseExportifyCsv(csv('spotify:track:a,GB1,,Alb,Art,2020,1000,0,false,u,')).skippedRows).toBe(1);
        expect(parseExportifyCsv('foo,bar\n1,2').tracks).toEqual([]);
        expect(parseExportifyCsv('').tracks).toEqual([]);
    });

    it('keeps CJK text intact', () => {
        const parsed = parseExportifyCsv(csv('spotify:track:a,CN1,"演员","初学者","薛之謙",2016,261249,69,false,u,2026-09-07T15:00:49Z'));
        expect(parsed.tracks[0]).toMatchObject({ title: '演员', artists: ['薛之謙'], album: '初学者' });
    });
});

describe('dedupeImportedTracks', () => {
    it('treats a repeated ISRC as the same recording even under a different URI', () => {
        const parsed = parseExportifyCsv(csv(
            'spotify:track:a,GB1,Same,Alb,Art,2020,1000,0,false,u,',
            'spotify:track:b,GB1,Same,Alb,Art,2020,1000,0,false,u,',
            'spotify:track:c,GB2,Other,Alb,Art,2020,1000,0,false,u,',
        ));
        expect(dedupeImportedTracks(parsed.tracks).map(track => track.sourceUri)).toEqual(['spotify:track:a', 'spotify:track:c']);
    });
});

describe('deriveListNameFromFileName', () => {
    it('strips directories, the extension and underscores', () => {
        expect(deriveListNameFromFileName('C:\\x\\Liked_Songs.csv')).toBe('Liked Songs');
    });
});

describe('matchImportedTrack', () => {
    const track = parseExportifyCsv(csv(
        'spotify:track:a,GB1,Levitating,Future Nostalgia,Dua Lipa,2020,203807,84,false,u,',
    )).tracks[0];

    it('accepts a candidate with matching title, artist and duration', async () => {
        const search: TrackSearch = async () => [
            song('Levitating', ['Dua Lipa'], 'Future Nostalgia', 203000),
            song('Levitating (Remix)', ['Someone Else'], 'Other', 190000),
        ];
        const result = await matchImportedTrack(track, search);
        expect(result.status).toBe('matched');
        expect(result.song?.album.name).toBe('Future Nostalgia');
    });

    it('flags a right-title, wrong-length hit as uncertain instead of matching it', async () => {
        const search: TrackSearch = async () => [song('Levitating', ['Dua Lipa'], 'Future Nostalgia', 330000)];
        const result = await matchImportedTrack(track, search);
        expect(result.status).toBe('uncertain');
    });

    it('reports unmatched when no candidate has the right title and artist', async () => {
        const search: TrackSearch = async () => [song('Totally Different', ['Nobody'], 'Nothing', 203807)];
        expect((await matchImportedTrack(track, search)).status).toBe('unmatched');
    });

    it('reports a search failure as failed, not as unmatched', async () => {
        const search: TrackSearch = async () => { throw new Error('boom'); };
        expect(await matchImportedTrack(track, search)).toMatchObject({ status: 'failed', error: 'boom' });
    });

    it('retries with a shorter query when the full one finds nothing', async () => {
        const queries: string[] = [];
        const search: TrackSearch = async query => {
            queries.push(query);
            return queries.length === 1 ? [] : [song('Levitating', ['Dua Lipa'], 'Future Nostalgia', 203807)];
        };
        expect((await matchImportedTrack(track, search)).status).toBe('matched');
        expect(queries).toEqual(['Levitating - Dua Lipa - Future Nostalgia', 'Levitating Dua Lipa']);
    });
});

describe('matchImportedTracks', () => {
    const tracks = parseExportifyCsv(csv(
        'spotify:track:a,GB1,One,Alb,Art,2020,1000,0,false,u,',
        'spotify:track:b,GB2,Two,Alb,Art,2020,1000,0,false,u,',
        'spotify:track:c,GB3,Three,Alb,Art,2020,1000,0,false,u,',
    )).tracks;

    it('keeps input order, reports progress and respects the concurrency bound', async () => {
        let active = 0;
        let peak = 0;
        const search: TrackSearch = async query => {
            active += 1;
            peak = Math.max(peak, active);
            await new Promise(resolve => setTimeout(resolve, 5));
            active -= 1;
            const title = query.split(' - ')[0].split(' ')[0];
            return [song(title, ['Art'], 'Alb', 1000)];
        };
        const progress: number[] = [];
        const results = await matchImportedTracks(tracks, search, {
            concurrency: 2,
            onProgress: ({ done }) => progress.push(done),
        });
        expect(results.map(result => result.track.title)).toEqual(['One', 'Two', 'Three']);
        expect(results.every(result => result.status === 'matched')).toBe(true);
        expect(peak).toBeLessThanOrEqual(2);
        expect(progress).toEqual([1, 2, 3]);
    });

    it('stops with an AbortError when cancelled', async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(matchImportedTracks(tracks, async () => [], { signal: controller.signal }))
            .rejects.toMatchObject({ name: 'AbortError' });
    });
});
