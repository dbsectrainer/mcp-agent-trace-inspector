import { DatabaseSync } from "node:sqlite";
export declare function handleListResources(db: DatabaseSync): {
    resources: Array<{
        uri: string;
        name: string;
        description: string;
        mimeType: string;
    }>;
};
export declare function handleReadResource(db: DatabaseSync, uri: string): {
    contents: Array<{
        uri: string;
        mimeType: string;
        text: string;
    }>;
};
