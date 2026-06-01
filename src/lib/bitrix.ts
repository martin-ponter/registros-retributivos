export type CurrentBitrixUser = {
    id: string;
    name: string;
    email?: string;
};

export type BitrixInitResult = {
    insideBitrix: boolean;
    auth: BitrixAuthData | null;
    user: CurrentBitrixUser | null;
};

function hasBitrix(): boolean {
    return typeof window !== "undefined" && Boolean(window.BX24);
}

function callBitrixMethod<T>(
    method: string,
    params: Record<string, unknown> = {},
): Promise<T> {
    return new Promise((resolve, reject) => {
        if (!window.BX24) {
            reject(
                new Error(
                    "BX24 no está disponible. La app no parece estar dentro de Bitrix.",
                ),
            );
            return;
        }

        window.BX24.callMethod<T>(method, params, (result) => {
            const error = result.error();

            if (error) {
                reject(error);
                return;
            }

            resolve(result.data());
        });
    });
}

export async function initBitrixApp(): Promise<BitrixInitResult> {
    if (!hasBitrix()) {
        return {
            insideBitrix: false,
            auth: null,
            user: null,
        };
    }

    return new Promise((resolve) => {
        window.BX24?.init(async () => {
            try {
                window.BX24?.setTitle?.("Registros Retributivos");
                window.BX24?.fitWindow?.();

                const auth = window.BX24?.getAuth?.() ?? null;
                const rawUser =
                    await callBitrixMethod<BitrixUser>("user.current");

                const name = [rawUser.NAME, rawUser.LAST_NAME]
                    .filter(Boolean)
                    .join(" ")
                    .trim();

                resolve({
                    insideBitrix: true,
                    auth,
                    user: {
                        id: rawUser.ID,
                        name: name || `Usuario ${rawUser.ID}`,
                        email: rawUser.EMAIL,
                    },
                });
            } catch {
                resolve({
                    insideBitrix: true,
                    auth: window.BX24?.getAuth?.() ?? null,
                    user: null,
                });
            }
        });
    });
}

export function finishBitrixInstall(): void {
    if (!hasBitrix()) {
        return;
    }

    window.BX24?.init(() => {
        window.BX24?.installFinish?.();
    });
}
