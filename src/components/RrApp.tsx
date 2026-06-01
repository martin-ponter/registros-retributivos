import { useEffect, useMemo, useState } from "react";
import {
    generateIaReport,
    getRrStatus,
    searchCompanies,
    type CompanySearchResult,
    type RrStatus,
} from "../lib/backend";
import { initBitrixApp, type CurrentBitrixUser } from "../lib/bitrix";

type LoadState = "idle" | "loading" | "success" | "error";

const FIXED_YEAR = 2025;

export default function RrApp() {
    const [insideBitrix, setInsideBitrix] = useState<boolean | null>(null);
    const [currentUser, setCurrentUser] = useState<CurrentBitrixUser | null>(
        null,
    );

    const [query, setQuery] = useState("");
    const [companies, setCompanies] = useState<CompanySearchResult[]>([]);
    const [selectedCompany, setSelectedCompany] =
        useState<CompanySearchResult | null>(null);
    const [status, setStatus] = useState<RrStatus | null>(null);

    const [searchState, setSearchState] = useState<LoadState>("idle");
    const [statusState, setStatusState] = useState<LoadState>("idle");
    const [actionState, setActionState] = useState<LoadState>("idle");
    const [errorMessage, setErrorMessage] = useState<string | null>(null);

    const year = FIXED_YEAR;
    const isGenerating = actionState === "loading";
    const canSearch = query.trim().length >= 2;

    const canGenerateReport = Boolean(
        selectedCompany &&
        status?.excelBiloop?.exists &&
        status.excelBiloop?.bitrixFileId &&
        status.bitrixCompanyFolderId &&
        !status?.iaReport?.exists &&
        !isGenerating,
    );

    const headerUserLabel = useMemo(() => {
        if (insideBitrix === null) return "Inicializando Bitrix...";
        if (!insideBitrix) return "Modo desarrollo fuera de Bitrix";
        if (!currentUser) return "Usuario Bitrix no detectado";
        return `${currentUser.name}${currentUser.email ? ` · ${currentUser.email}` : ""}`;
    }, [insideBitrix, currentUser]);

    useEffect(() => {
        let mounted = true;

        initBitrixApp().then((result) => {
            if (!mounted) return;

            setInsideBitrix(result.insideBitrix);
            setCurrentUser(result.user);
        });

        return () => {
            mounted = false;
        };
    }, []);

    useEffect(() => {
        const trimmedQuery = query.trim();

        if (trimmedQuery.length < 2) {
            setCompanies([]);
            setSelectedCompany(null);
            setStatus(null);
            setSearchState("idle");
            setStatusState("idle");
            setActionState("idle");
            setErrorMessage(null);
            return;
        }

        let cancelled = false;

        const timeoutId = window.setTimeout(async () => {
            setErrorMessage(null);
            setSearchState("loading");

            try {
                const result = await searchCompanies(trimmedQuery);

                if (cancelled) return;

                setCompanies(result);
                setSearchState("success");
            } catch (error) {
                if (cancelled) return;

                setCompanies([]);
                setSearchState("error");
                setErrorMessage(
                    error instanceof Error
                        ? error.message
                        : "Error buscando empresas.",
                );
            }
        }, 300);

        return () => {
            cancelled = true;
            window.clearTimeout(timeoutId);
        };
    }, [query]);

    async function handleSearch() {
        if (!canSearch) return;

        setErrorMessage(null);
        setSelectedCompany(null);
        setStatus(null);
        setStatusState("idle");
        setActionState("idle");
        setSearchState("loading");

        try {
            const result = await searchCompanies(query.trim());
            setCompanies(result);
            setSearchState("success");
        } catch (error) {
            setCompanies([]);
            setSearchState("error");
            setErrorMessage(
                error instanceof Error
                    ? error.message
                    : "Error buscando empresas.",
            );
        }
    }

    async function handleSelectCompany(company: CompanySearchResult) {
        if (isGenerating) return;

        setSelectedCompany(company);
        setStatus(null);
        setErrorMessage(null);
        setStatusState("loading");
        setActionState("idle");

        try {
            const result = await getRrStatus({
                companyId: company.id,
                year,
            });

            setStatus(result);
            setStatusState("success");
        } catch (error) {
            setStatusState("error");
            setErrorMessage(
                error instanceof Error
                    ? error.message
                    : "Error consultando estado.",
            );
        }
    }

    async function handleGenerateIaReport() {
        if (isGenerating) return;
        if (!selectedCompany || !status) return;

        const bitrixExcelFileId = status.excelBiloop?.bitrixFileId;
        const bitrixFolderId = status.bitrixCompanyFolderId;

        if (!bitrixExcelFileId) {
            setErrorMessage("No se ha encontrado el ID del Excel de Biloop.");
            return;
        }

        if (!bitrixFolderId) {
            setErrorMessage(
                "No se ha encontrado la carpeta de empresa en Bitrix Drive.",
            );
            return;
        }

        setErrorMessage(null);
        setActionState("loading");

        try {
            await generateIaReport({
                bitrixExcelFileId,
                bitrixFolderId,
                outputFileName: buildIaReportFileName({
                    companyName: status.companyName,
                    cif: status.cif || selectedCompany.cif || "",
                    year,
                }),
                companyName: status.companyName,
                cif: status.cif || selectedCompany.cif,
                year,
                requestedByBitrixUserId: currentUser?.id,
            });

            const refreshed = await getRrStatus({
                companyId: selectedCompany.id,
                year,
            });

            setStatus(refreshed);
            setActionState("success");
        } catch (error) {
            setActionState("error");
            setErrorMessage(
                error instanceof Error
                    ? error.message
                    : "Error generando informe IA.",
            );
        }
    }

    function buildIaReportFileName(params: {
        companyName: string;
        cif: string;
        year: number;
    }): string {
        const cifPart = sanitizeFileName(params.cif || "sin-cif");
        const companyPart = sanitizeFileName(params.companyName || "empresa");

        return `informe-ia-${params.year}-${cifPart}-${companyPart}.docx`;
    }

    function sanitizeFileName(value: string): string {
        return value
            .normalize("NFD")
            .replace(/\p{Diacritic}/gu, "")
            .replace(/[^a-zA-Z0-9._-]+/g, "-")
            .replace(/-+/g, "-")
            .replace(/^-|-$/g, "")
            .slice(0, 120)
            .toLowerCase();
    }

    const statusMessage = status?.message || null;

    return (
        <main className="h-[100dvh] overflow-hidden bg-gray-100 p-2 md:p-3">
            <section className="mx-auto flex h-full max-w-7xl flex-col gap-2 md:gap-3">
                <header className="shrink-0 rounded-2xl border border-gray-200 bg-white px-4 py-3 shadow-sm md:px-5">
                    <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                            <p className="text-xs font-medium text-gray-500">
                                Ponter · Laboral
                            </p>

                            <h1 className="truncate text-xl font-bold text-gray-950 md:text-2xl">
                                Registros Retributivos
                            </h1>

                            <p className="mt-1 hidden max-w-3xl text-xs text-gray-600 md:block">
                                Busca una empresa por nombre o CIF, comprueba si
                                existe su Excel de Biloop y genera el informe
                                IA.
                            </p>
                        </div>

                        <div className="max-w-[45%] truncate rounded-xl bg-gray-50 px-3 py-2 text-xs text-gray-700 md:max-w-none md:text-sm">
                            {headerUserLabel}
                        </div>
                    </div>
                </header>

                {errorMessage && (
                    <div className="shrink-0 rounded-2xl border border-red-200 bg-red-50 px-4 py-2 text-xs text-red-800 md:text-sm">
                        {errorMessage}
                    </div>
                )}

                <section className="grid min-h-0 flex-1 grid-rows-[minmax(210px,0.42fr)_minmax(0,1fr)] gap-2 md:gap-3 lg:grid-cols-[380px_minmax(0,1fr)] lg:grid-rows-1">
                    <aside className="flex min-h-0 flex-col rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
                        <div className="shrink-0">
                            <div className="flex items-center justify-between gap-3">
                                <h2 className="text-base font-semibold text-gray-950">
                                    Buscar empresa
                                </h2>

                                <span className="rounded-full bg-gray-100 px-3 py-1 text-xs font-semibold text-gray-700">
                                    Año {year}
                                </span>
                            </div>

                            <div className="mt-3 space-y-3">
                                <label className="block">
                                    <span className="text-xs font-medium text-gray-700">
                                        Nombre o CIF
                                    </span>

                                    <input
                                        value={query}
                                        onChange={(event) => {
                                            setQuery(event.target.value);
                                            setSelectedCompany(null);
                                            setStatus(null);
                                            setStatusState("idle");
                                            setActionState("idle");
                                        }}
                                        onKeyDown={(event) => {
                                            if (event.key === "Enter") {
                                                void handleSearch();
                                            }
                                        }}
                                        placeholder="Ej: 60392288S o ZORRILLA"
                                        className="mt-1 w-full rounded-xl border border-gray-300 bg-white px-4 py-2.5 text-sm outline-none ring-0 transition focus:border-gray-900"
                                    />
                                </label>

                                <button
                                    type="button"
                                    onClick={() => void handleSearch()}
                                    disabled={
                                        !canSearch || searchState === "loading"
                                    }
                                    className="w-full rounded-xl bg-gray-950 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-gray-800 disabled:cursor-not-allowed disabled:bg-gray-300"
                                >
                                    {searchState === "loading"
                                        ? "Buscando..."
                                        : "Buscar ahora"}
                                </button>
                            </div>
                        </div>

                        <div className="mt-3 min-h-0 flex-1 overflow-y-auto pr-1">
                            <div className="space-y-2">
                                {query.trim().length < 2 && (
                                    <p className="rounded-xl bg-gray-50 p-3 text-sm text-gray-600">
                                        Escribe al menos 2 caracteres para
                                        buscar por nombre o CIF.
                                    </p>
                                )}

                                {query.trim().length >= 2 &&
                                    searchState === "loading" && (
                                        <p className="rounded-xl bg-gray-50 p-3 text-sm text-gray-600">
                                            Buscando coincidencias...
                                        </p>
                                    )}

                                {query.trim().length >= 2 &&
                                    companies.length === 0 &&
                                    searchState === "success" && (
                                        <p className="rounded-xl bg-gray-50 p-3 text-sm text-gray-600">
                                            No se han encontrado empresas.
                                        </p>
                                    )}

                                {companies.map((company) => {
                                    const selected =
                                        selectedCompany?.id === company.id;

                                    return (
                                        <button
                                            key={company.id}
                                            type="button"
                                            disabled={isGenerating}
                                            onClick={() =>
                                                void handleSelectCompany(
                                                    company,
                                                )
                                            }
                                            className={`w-full rounded-xl border p-3 text-left transition disabled:cursor-not-allowed disabled:opacity-60 ${
                                                selected
                                                    ? "border-gray-950 bg-gray-950 text-white"
                                                    : "border-gray-200 bg-white hover:bg-gray-50"
                                            }`}
                                        >
                                            <div className="line-clamp-2 text-sm font-semibold">
                                                {company.title}
                                            </div>

                                            <div
                                                className={`mt-1 text-xs ${
                                                    selected
                                                        ? "text-gray-300"
                                                        : "text-gray-500"
                                                }`}
                                            >
                                                {company.cif ||
                                                    "Sin CIF detectado"}
                                            </div>
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    </aside>

                    <section className="min-h-0 overflow-hidden rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
                        <div className="flex h-full min-h-0 flex-col">
                            <div className="shrink-0">
                                <div className="flex items-center justify-between gap-3">
                                    <h2 className="text-base font-semibold text-gray-950 md:text-lg">
                                        Estado del registro
                                    </h2>

                                    {isGenerating && (
                                        <span className="rounded-full bg-blue-50 px-3 py-1 text-xs font-semibold text-blue-700">
                                            Generando informe...
                                        </span>
                                    )}
                                </div>
                            </div>

                            {!selectedCompany && (
                                <div className="mt-3 flex flex-1 items-center justify-center rounded-2xl bg-gray-50 p-6 text-center text-sm text-gray-600">
                                    Selecciona una empresa para ver si ya tiene
                                    Excel de Biloop e informe generado.
                                </div>
                            )}

                            {selectedCompany && statusState === "loading" && (
                                <div className="mt-3 flex flex-1 items-center justify-center rounded-2xl bg-gray-50 p-6 text-center text-sm text-gray-600">
                                    Consultando Bitrix Drive...
                                </div>
                            )}

                            {selectedCompany && status && (
                                <div className="mt-3 grid min-h-0 flex-1 grid-rows-[auto_auto_minmax(0,1fr)] gap-3">
                                    <div className="rounded-2xl bg-gray-50 p-3">
                                        <div className="text-xs text-gray-500">
                                            Empresa seleccionada
                                        </div>

                                        <div className="mt-1 line-clamp-1 text-base font-bold text-gray-950 md:text-lg">
                                            {status.companyName}
                                        </div>

                                        <div className="text-xs text-gray-600 md:text-sm">
                                            CIF:{" "}
                                            {status.cif ||
                                                selectedCompany.cif ||
                                                "No informado"}{" "}
                                            · Año: {status.year}
                                        </div>

                                        {statusMessage && (
                                            <p className="mt-2 line-clamp-2 text-xs text-amber-700 md:text-sm">
                                                {statusMessage}
                                            </p>
                                        )}
                                    </div>

                                    <div className="grid gap-2 md:grid-cols-3">
                                        <StatusCard
                                            title="Excel Biloop"
                                            exists={Boolean(
                                                status.excelBiloop?.exists,
                                            )}
                                            url={status.excelBiloop?.url}
                                            fileName={
                                                status.excelBiloop?.fileName
                                            }
                                        />

                                        <StatusCard
                                            title="Informe IA"
                                            exists={Boolean(
                                                status.iaReport?.exists,
                                            )}
                                            url={status.iaReport?.url}
                                            fileName={status.iaReport?.fileName}
                                        />

                                        <StatusCard
                                            title="Informe final"
                                            exists={Boolean(
                                                status.finalReport?.exists,
                                            )}
                                            url={status.finalReport?.url}
                                            fileName={
                                                status.finalReport?.fileName
                                            }
                                        />
                                    </div>

                                    <div className="min-h-0 rounded-2xl border border-gray-200 p-3">
                                        <div className="flex flex-wrap items-center justify-between gap-2">
                                            <h3 className="font-semibold text-gray-950">
                                                Acciones disponibles
                                            </h3>

                                            <div className="flex flex-wrap gap-2">
                                                {status.folderUrl && (
                                                    <a
                                                        href={status.folderUrl}
                                                        target="_blank"
                                                        rel="noreferrer"
                                                        className="rounded-xl border border-gray-300 px-3 py-2 text-xs font-semibold text-gray-900 transition hover:bg-gray-50 md:text-sm"
                                                    >
                                                        Abrir carpeta
                                                    </a>
                                                )}

                                                {status.iaReport?.url && (
                                                    <a
                                                        href={
                                                            status.iaReport.url
                                                        }
                                                        target="_blank"
                                                        rel="noreferrer"
                                                        className="rounded-xl border border-gray-300 px-3 py-2 text-xs font-semibold text-gray-900 transition hover:bg-gray-50 md:text-sm"
                                                    >
                                                        Descargar IA
                                                    </a>
                                                )}

                                                {status.finalReport?.url && (
                                                    <a
                                                        href={
                                                            status.finalReport
                                                                .url
                                                        }
                                                        target="_blank"
                                                        rel="noreferrer"
                                                        className="rounded-xl border border-gray-300 px-3 py-2 text-xs font-semibold text-gray-900 transition hover:bg-gray-50 md:text-sm"
                                                    >
                                                        Descargar final
                                                    </a>
                                                )}
                                            </div>
                                        </div>

                                        <div className="mt-3">
                                            <button
                                                type="button"
                                                onClick={() =>
                                                    void handleGenerateIaReport()
                                                }
                                                disabled={
                                                    !canGenerateReport ||
                                                    isGenerating
                                                }
                                                className="rounded-xl bg-gray-950 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-gray-800 disabled:cursor-not-allowed disabled:bg-gray-300"
                                            >
                                                {isGenerating
                                                    ? "Generando informe..."
                                                    : "Generar informe IA"}
                                            </button>
                                        </div>

                                        {!status.excelBiloop?.exists && (
                                            <p className="mt-2 text-xs text-amber-700 md:text-sm">
                                                No aparece el Excel de Biloop en
                                                Drive. Primero habrá que revisar
                                                la carpeta de la empresa.
                                            </p>
                                        )}

                                        {status.excelBiloop?.exists &&
                                            status.iaReport?.exists && (
                                                <p className="mt-2 text-xs text-gray-600 md:text-sm">
                                                    Ya existe informe IA para
                                                    esta empresa y año.
                                                </p>
                                            )}

                                        {status.excelBiloop?.exists &&
                                            !status.iaReport?.exists &&
                                            !canGenerateReport &&
                                            !isGenerating && (
                                                <p className="mt-2 text-xs text-amber-700 md:text-sm">
                                                    Existe el Excel, pero falta
                                                    el ID del archivo o de la
                                                    carpeta. Revisa la respuesta
                                                    de /api/rr/status.
                                                </p>
                                            )}
                                    </div>
                                </div>
                            )}
                        </div>
                    </section>
                </section>
            </section>
        </main>
    );
}

function StatusCard(props: {
    title: string;
    exists: boolean;
    fileName?: string | null;
    url?: string | null;
}) {
    return (
        <div className="min-w-0 rounded-2xl border border-gray-200 p-3">
            <div className="flex items-center justify-between gap-2">
                <h3 className="truncate text-sm font-semibold text-gray-950">
                    {props.title}
                </h3>

                <span
                    className={`shrink-0 rounded-full px-2 py-1 text-[11px] font-semibold ${
                        props.exists
                            ? "bg-green-100 text-green-800"
                            : "bg-gray-100 text-gray-600"
                    }`}
                >
                    {props.exists ? "Existe" : "Pendiente"}
                </span>
            </div>

            <p className="mt-2 line-clamp-2 min-h-8 text-xs text-gray-600">
                {props.fileName || "No localizado todavía"}
            </p>

            {props.url && (
                <a
                    href={props.url}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-2 inline-flex text-xs font-semibold text-gray-950 underline"
                >
                    Abrir documento
                </a>
            )}
        </div>
    );
}
