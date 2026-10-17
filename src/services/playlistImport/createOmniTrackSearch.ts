import type { OmniProviderId } from '../../types/onlineMusic';
import { omni } from '../onlineMusic/omni';
import type { TrackSearch } from './matchImportedTracks';

// src/services/playlistImport/createOmniTrackSearch.ts
// Binds the importer's search to one explicitly chosen provider; all provider access stays behind Omni.

const SEARCH_PAGE_SIZE = 10;

export const createOmniTrackSearch = (providerId: OmniProviderId): TrackSearch => async query => {
    const page = await omni.searchProviderSongs(providerId, query, { limit: SEARCH_PAGE_SIZE, offset: 0 });
    return page.items;
};
