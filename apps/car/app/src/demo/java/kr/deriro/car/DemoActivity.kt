package kr.deriro.car

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import kr.deriro.car.demo.DemoCarViewModel
import kr.deriro.car.ui.DemoCar

class DemoActivity : ComponentActivity() {
    private val model: DemoCarViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent { DemoCar(model) }
    }
}
