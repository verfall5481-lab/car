package kr.deriro.car.live

import android.app.Application
import kotlinx.coroutines.CoroutineScope
import kr.deriro.car.BuildConfig
import kr.deriro.car.platform.PleosNavigationGateway
import kr.deriro.car.platform.PleosVehicleSignals

/** Real collaborators for [LiveCarViewModel]: Supabase backend, Keystore vault, AAOS/Pleos signals and NaviHelper. */
internal fun androidLiveCarDependencies(app: Application, scope: CoroutineScope): LiveCarDependencies {
    val config = BackendConfig.create(BuildConfig.SUPABASE_URL, BuildConfig.SUPABASE_KEY, BuildConfig.WEB_URL, BuildConfig.DEBUG)
    val vault = config?.let { AndroidVehicleVault(app, it.origin.toString().trimEnd('/')) }
    val backend = config?.let { VehicleBackend(it, checkNotNull(vault)) }
    val signals = PleosVehicleSignals(app, scope)
    val navigation = PleosNavigationGateway(app, scope, locate = { signals.freshLocation(ARRIVAL_FIX_TIMEOUT_MS) })
    return LiveCarDependencies(
        backend = backend,
        vault = vault,
        signals = signals,
        navigation = navigation,
        alerts = AndroidCardAlerts(app),
        tripKeeper = AndroidTripKeeper(app),
        pairUrl = { code -> config?.pairUrl(code) },
        commands = LiveCarActionBus.flow,
    )
}

private const val ARRIVAL_FIX_TIMEOUT_MS = 5_000L
