import type { APIRoute } from "astro";

export const prerender = false;

type BitrixCompany = Record<string, unknown>;

type BitrixDiskItem = {
    ID: string;
    NAME: string;
    TYPE?: string;
    DETAIL_URL?: string;
    DOWNLOAD_URL?: string;
    CREATE_TIME?: string;
    UPDATE_TIME?: string;
};

type BitrixResponse<T> = {
    result: T;
    next?: number;
    total?: number;
    error?: string;
    error_description?: string;
};

const BITRIX_WEBHOOK_URL = process.env.BITRIX_WEBHOOK_URL?.replace(/\/$/, "");
const CIF_FIELD = (process.env.BITRIX_COMPANY_CIF_FIELD || "")
    .trim()
    .toUpperCase();
const REGISTROS_FOLDER_ID =
    process.env.RR_BITRIX_DRIVE_FOLDER_ID ||
    process.env.RR_BITRIX_REGISTROS_FOLDER_ID ||
    "";
const DEFAULT_YEAR = Number(process.env.RR_DEFAULT_YEAR || "2025");

export const GET: APIRoute = async ({ request }) => {
    try {
        const url = new URL(request.url);
        const companyId = url.searchParams.get("companyId")?.trim();
        const year = Number(url.searchParams.get("year") || DEFAULT_YEAR);

        if (!companyId) {
            return json({ error: "Falta companyId." }, 400);
        }

        if (!BITRIX_WEBHOOK_URL) {
            return json({ error: "Falta BITRIX_WEBHOOK_URL en Vercel." }, 500);
        }

        if (!REGISTROS_FOLDER_ID) {
            return json(
                { error: "Falta RR_BITRIX_REGISTROS_FOLDER_ID en Vercel." },
                500,
            );
        }

        const company = await getCompany(companyId);
        const companyName =
            stringValue(company.TITLE) || `Empresa ${companyId}`;
        const cif = CIF_FIELD
            ? stringValue(getCaseInsensitive(company, CIF_FIELD))
            : "";

        const emptyStatus = {
            companyId,
            companyName,
            cif,
            year,
            folderUrl: null,
            bitrixYearFolderId: null,
            bitrixCompanyFolderId: null,
            excelBiloop: {
                exists: false,
                fileName: null,
                url: null,
                bitrixFileId: null,
            },
            iaReport: {
                exists: false,
                fileName: null,
                url: null,
                bitrixFileId: null,
            },
            finalReport: {
                exists: false,
                fileName: null,
                url: null,
                bitrixFileId: null,
            },
            currentJob: null,
        };

        /*
      Estructura correcta:
      Registros Retributivos / 2025 / Empresa
    */

        const rootChildren = await getAllFolderChildren(REGISTROS_FOLDER_ID);

        const yearFolder = rootChildren.find((item) => {
            return (
                isFolder(item) && normalizeSimple(item.NAME) === String(year)
            );
        });

        if (!yearFolder) {
            return json({
                ...emptyStatus,
                message: `No se ha encontrado la carpeta ${year} dentro de Registros Retributivos.`,
            });
        }

        const yearChildren = await getAllFolderChildren(yearFolder.ID);

        const companyFolder = findBestCompanyFolder(yearChildren, {
            companyName,
            cif,
        });

        if (!companyFolder) {
            return json({
                ...emptyStatus,
                folderUrl: yearFolder.DETAIL_URL || null,
                bitrixYearFolderId: yearFolder.ID,
                message: `No se ha encontrado carpeta de empresa dentro de Registros Retributivos / ${year}.`,
            });
        }

        const companyChildren = await getAllFolderChildren(companyFolder.ID);

        const excel = findExcelBiloop(companyChildren);
        const iaReport = findIaReport(companyChildren);
        const finalReport = findFinalReport(companyChildren);

        return json({
            companyId,
            companyName,
            cif,
            year,
            folderUrl:
                companyFolder.DETAIL_URL || yearFolder.DETAIL_URL || null,
            bitrixYearFolderId: yearFolder.ID,
            bitrixCompanyFolderId: companyFolder.ID,
            excelBiloop: fileStatus(excel),
            iaReport: fileStatus(iaReport),
            finalReport: fileStatus(finalReport),
            currentJob: null,
        });
    } catch (error) {
        const message =
            error instanceof Error
                ? error.message
                : "Error consultando estado RR.";

        return json({ error: message }, 500);
    }
};

async function getCompany(companyId: string): Promise<BitrixCompany> {
    const response = await callBitrix<BitrixCompany>("crm.company.get", {
        id: companyId,
    });

    return response.result;
}

async function getAllFolderChildren(
    folderId: string,
): Promise<BitrixDiskItem[]> {
    const all: BitrixDiskItem[] = [];
    let start: number | undefined = undefined;

    for (;;) {
        const params: Record<string, unknown> = {
            id: folderId,
        };

        if (start !== undefined) {
            params.start = start;
        }

        const response = await callBitrix<BitrixDiskItem[]>(
            "disk.folder.getchildren",
            params,
        );

        if (Array.isArray(response.result)) {
            all.push(...response.result);
        }

        if (response.next === undefined || response.next === null) {
            break;
        }

        start = response.next;
    }

    return all;
}

async function callBitrix<T>(
    method: string,
    params: Record<string, unknown>,
): Promise<BitrixResponse<T>> {
    if (!BITRIX_WEBHOOK_URL) {
        throw new Error("Falta BITRIX_WEBHOOK_URL.");
    }

    const response = await fetch(`${BITRIX_WEBHOOK_URL}/${method}.json`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify(params),
    });

    const data = (await response
        .json()
        .catch(() => null)) as BitrixResponse<T> | null;

    if (!response.ok || !data || data.error) {
        throw new Error(
            data?.error_description ||
                data?.error ||
                `Error llamando a Bitrix REST: ${response.status}`,
        );
    }

    return data;
}

function findBestCompanyFolder(
    items: BitrixDiskItem[],
    params: {
        companyName: string;
        cif: string;
    },
): BitrixDiskItem | null {
    const folders = items.filter(isFolder);

    let best: {
        item: BitrixDiskItem;
        score: number;
    } | null = null;

    for (const item of folders) {
        const score = getCompanyFolderScore(
            item.NAME,
            params.companyName,
            params.cif,
        );

        if (score > 0 && (!best || score > best.score)) {
            best = {
                item,
                score,
            };
        }
    }

    return best?.item || null;
}

function getCompanyFolderScore(
    folderName: string,
    companyName: string,
    cif: string,
): number {
    const folderCompact = compact(folderName);
    const folderNormalized = normalizeText(folderName);

    const companyCompact = compact(companyName);
    const companyNormalized = normalizeText(companyName);

    const cifCompact = compact(cif);

    if (cifCompact && folderCompact.includes(cifCompact)) {
        return 100;
    }

    if (folderCompact === companyCompact) {
        return 95;
    }

    if (folderNormalized === companyNormalized) {
        return 90;
    }

    if (folderNormalized.includes(companyNormalized)) {
        return 80;
    }

    const tokens = companyNormalized
        .split(" ")
        .map((token) => token.trim())
        .filter((token) => token.length >= 3)
        .filter((token) => !["SL", "SLU", "SA", "SLL", "CB"].includes(token));

    if (tokens.length === 0) {
        return 0;
    }

    const matched = tokens.filter((token) =>
        folderNormalized.includes(token),
    ).length;
    const ratio = matched / tokens.length;

    if (ratio >= 0.8) {
        return 70;
    }

    if (ratio >= 0.6) {
        return 50;
    }

    return 0;
}

function findExcelBiloop(items: BitrixDiskItem[]): BitrixDiskItem | null {
    const files = items.filter(isFile);

    const spreadsheets = files.filter((item) => {
        const name = item.NAME.toLowerCase();

        return (
            name.endsWith(".xlsx") ||
            name.endsWith(".xls") ||
            name.endsWith(".xlsm") ||
            name.endsWith(".csv")
        );
    });

    const preferred = spreadsheets.find((item) => {
        const name = normalizeText(item.NAME);

        return name.includes("BILOOP") || name.includes("REGISTRO");
    });

    return preferred || spreadsheets[0] || null;
}

function findIaReport(items: BitrixDiskItem[]): BitrixDiskItem | null {
    const files = items.filter(isFile);

    return (
        files.find((item) => {
            const name = normalizeText(item.NAME);

            return (
                isDocx(item.NAME) &&
                name.includes("INFORME") &&
                (name.includes("IA") || name.includes("AI"))
            );
        }) ||
        files.find((item) => {
            const name = normalizeText(item.NAME);

            return isDocx(item.NAME) && name.includes("INFORME");
        }) ||
        null
    );
}

function findFinalReport(items: BitrixDiskItem[]): BitrixDiskItem | null {
    const files = items.filter(isFile);

    return (
        files.find((item) => {
            const name = normalizeText(item.NAME);

            return (
                isDocx(item.NAME) &&
                (name.includes("FINAL") ||
                    name.includes("EDITADO") ||
                    name.includes("REVISADO") ||
                    name.includes("CONFIRMADO"))
            );
        }) || null
    );
}

function fileStatus(file: BitrixDiskItem | null) {
    return {
        exists: Boolean(file),
        fileName: file?.NAME || null,
        url: file?.DETAIL_URL || file?.DOWNLOAD_URL || null,
        bitrixFileId: file?.ID || null,
    };
}

function isFolder(item: BitrixDiskItem): boolean {
    return item.TYPE === "folder";
}

function isFile(item: BitrixDiskItem): boolean {
    return item.TYPE === "file";
}

function isDocx(name: string): boolean {
    return name.toLowerCase().endsWith(".docx");
}

function getCaseInsensitive(
    object: Record<string, unknown>,
    key: string,
): unknown {
    return (
        object[key] ?? object[key.toUpperCase()] ?? object[key.toLowerCase()]
    );
}

function stringValue(value: unknown): string {
    if (value === null || value === undefined) return "";
    return String(value).trim();
}

function normalizeSimple(value: string): string {
    return value.trim().toUpperCase();
}

function normalizeText(value: string): string {
    return value
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "")
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, " ")
        .trim();
}

function compact(value: string): string {
    return value
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "")
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "");
}

function json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            "Content-Type": "application/json; charset=utf-8",
        },
    });
}
