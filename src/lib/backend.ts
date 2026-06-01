const API_BASE_URL = import.meta.env.PUBLIC_RR_API_BASE_URL;

export type CompanySearchResult = {
    id: string;
    title: string;
    cif?: string;
};

export type RrStatus = {
    companyId: string;
    companyName: string;
    cif: string;
    year: number;
    folderUrl?: string | null;
    bitrixYearFolderId?: string | null;
    bitrixCompanyFolderId?: string | null;
    excelBiloop?: {
        exists: boolean;
        fileName?: string | null;
        url?: string | null;
        bitrixFileId?: string | null;
    };
    iaReport?: {
        exists: boolean;
        fileName?: string | null;
        url?: string | null;
        bitrixFileId?: string | null;
    };
    finalReport?: {
        exists: boolean;
        fileName?: string | null;
        url?: string | null;
        bitrixFileId?: string | null;
    };
    currentJob?: {
        id: string;
        status: "queued" | "running" | "done" | "error";
        message?: string;
    } | null;
    message?: string;
};

export type GenerateReportResponse = {
    ok?: boolean;
    jobId?: string;
    fileName?: string;
    bitrixUpload?: unknown;
    unresolvedTags?: string[];
    error?: string;
};

function getApiBaseUrl(): string {
    if (!API_BASE_URL) {
        throw new Error(
            "Falta PUBLIC_RR_API_BASE_URL en las variables de entorno.",
        );
    }

    return API_BASE_URL.replace(/\/$/, "");
}

async function apiFetch<T>(
    path: string,
    options: RequestInit = {},
): Promise<T> {
    const response = await fetch(`${getApiBaseUrl()}${path}`, {
        ...options,
        headers: {
            "Content-Type": "application/json",
            ...(options.headers ?? {}),
        },
    });

    const contentType = response.headers.get("content-type") || "";

    if (!response.ok) {
        if (contentType.includes("application/json")) {
            const data = (await response.json().catch(() => null)) as {
                error?: string;
                message?: string;
            } | null;

            throw new Error(
                data?.error ||
                    data?.message ||
                    `Error HTTP ${response.status} en ${path}`,
            );
        }

        throw new Error(`Error HTTP ${response.status} en ${path}`);
    }

    if (contentType.includes("application/json")) {
        return response.json() as Promise<T>;
    }

    throw new Error(`La ruta ${path} no ha devuelto JSON.`);
}

export async function searchCompanies(
    query: string,
): Promise<CompanySearchResult[]> {
    const params = new URLSearchParams({ query });

    return apiFetch<CompanySearchResult[]>(
        `/api/companies/search?${params.toString()}`,
    );
}

export async function getRrStatus(params: {
    companyId: string;
    year: number;
}): Promise<RrStatus> {
    const searchParams = new URLSearchParams({
        companyId: params.companyId,
        year: String(params.year),
    });

    return apiFetch<RrStatus>(`/api/rr/status?${searchParams.toString()}`);
}

export async function generateIaReport(params: {
    bitrixExcelFileId: string;
    bitrixFolderId: string;
    outputFileName: string;
    companyName: string;
    cif?: string;
    year: number;
    requestedByBitrixUserId?: string;
}): Promise<GenerateReportResponse> {
    return apiFetch<GenerateReportResponse>(
        "/api/generarInforme/generarInforme",
        {
            method: "POST",
            body: JSON.stringify({
                bitrixExcelFileId: params.bitrixExcelFileId,
                bitrixFolderId: params.bitrixFolderId,
                outputFileName: params.outputFileName,
                contextText: [
                    `Empresa seleccionada en Bitrix: ${params.companyName}`,
                    `CIF/NIF: ${params.cif || "Dato no disponible"}`,
                    `Año del registro retributivo: ${params.year}`,
                    params.requestedByBitrixUserId
                        ? `Usuario Bitrix solicitante: ${params.requestedByBitrixUserId}`
                        : "",
                    "El informe debe generarse usando como fuente principal el Excel de registro retributivo descargado desde Bitrix Drive.",
                ]
                    .filter(Boolean)
                    .join("\n"),
            }),
        },
    );
}
