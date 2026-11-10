package kr.deriro.car

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import kr.deriro.car.live.CardCommand
import kr.deriro.car.live.LiveCarViewModel
import kr.deriro.car.live.LiveNotifications
import kr.deriro.car.ui.LiveCar

class PleosActivity : ComponentActivity() {
    private val model: LiveCarViewModel by viewModels { LiveCarViewModel.Factory }
    private val permissions = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { model.refresh() }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent { LiveCar(model, onVehiclePermissions = ::requestVehiclePermissions, onLocationPermission = ::requestLocationPermission) }
        if (savedInstanceState == null) handleCardIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleCardIntent(intent)
    }

    override fun onStart() {
        super.onStart()
        model.setForeground(true)
    }

    override fun onStop() {
        // Sync continues in the background (navigation in front); only the poll pace and alert style change.
        model.setForeground(false)
        super.onStop()
    }

    /** Heads-up taps and the "출발하고 안내" / "위치 확인" buttons arrive here with the card they belong to. */
    private fun handleCardIntent(intent: Intent?) {
        val key = intent?.getStringExtra(LiveNotifications.EXTRA_CARD) ?: return
        model.handleCardCommand(CardCommand(key, intent.getStringExtra(LiveNotifications.EXTRA_ACTION)))
        intent.removeExtra(LiveNotifications.EXTRA_CARD)
        intent.removeExtra(LiveNotifications.EXTRA_ACTION)
    }

    private fun requestVehiclePermissions() {
        val state = model.state.value
        if (!state.parked && !state.permissionSetupAllowed) return
        val wanted = buildList {
            addAll(listOf("android.car.permission.CAR_ENERGY", "android.car.permission.CAR_POWERTRAIN",
                "android.car.permission.CAR_SPEED", "pleos.car.permission.CAR_ENERGY"))
            if (Build.VERSION.SDK_INT >= 33) add(Manifest.permission.POST_NOTIFICATIONS)
        }
        val missing = wanted.filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
        if (missing.isNotEmpty()) permissions.launch(missing.toTypedArray())
    }

    private fun requestLocationPermission() {
        if (!model.state.value.parked) return
        permissions.launch(arrayOf(Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.ACCESS_FINE_LOCATION))
    }
}
