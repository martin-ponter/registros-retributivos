/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />

type BitrixCallResult<T = unknown> = {
    data: () => T;
    error: () => unknown;
};

type BitrixAuthData = {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    domain?: string;
    member_id?: string;
    client_endpoint?: string;
    server_endpoint?: string;
};

type BitrixUser = {
    ID: string;
    NAME?: string;
    LAST_NAME?: string;
    EMAIL?: string;
};

type Bitrix24 = {
    init: (callback: () => void) => void;
    install?: (callback: () => void) => void;
    installFinish?: () => void;
    callMethod: <T = unknown>(
        method: string,
        params: Record<string, unknown>,
        callback: (result: BitrixCallResult<T>) => void,
    ) => void;
    getAuth?: () => BitrixAuthData;
    fitWindow?: () => void;
    resizeWindow?: (width: number, height: number) => void;
    setTitle?: (title: string) => void;
};

interface Window {
    BX24?: Bitrix24;
}
