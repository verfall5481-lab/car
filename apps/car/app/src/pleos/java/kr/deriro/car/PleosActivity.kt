package kr.deriro.car

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import kr.deriro.car.live.LiveCarViewModel
import kr.deriro.car.ui.LiveCar

class PleosActivity : ComponentActivity() {
    private val model: LiveCarViewModel by viewModels()
    private val permissions = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { model.refresh() }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent { LiveCar(model, onVehiclePermissions = ::requestVehiclePermissions, onLocationPermission = ::requestLocationPermission) }
    }

    override fun onStart() {
        super.onStart()
        model.setForeground(true)
    }

    override fun onStop() {
        model.setForeground(false)
        super.onStop()
    }

    private fun requestVehiclePermissions() {
        val state = model.state.value
        if (!state.parked && !state.permissionSetupAllowed) return
        val missing = listOf("android.car.permission.CAR_ENERGY", "android.car.permission.CAR_POWERTRAIN",
            "android.car.permission.CAR_SPEED", "pleos.car.permission.CAR_ENERGY")
            .filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
        if (missing.isNotEmpty()) permissions.launch(missing.toTypedArray())
    }

    private fun requestLocationPermission() {
        if (!model.state.value.parked) return
        permissions.launch(arrayOf(Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.ACCESS_FINE_LOCATION))
    }
}
