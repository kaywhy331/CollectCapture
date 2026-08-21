package com.localclear.sellerhub

import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val scanner = GmsBarcodeScanning.getClient(
            this,
            GmsBarcodeScannerOptions.Builder()
                .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
                .enableAutoZoom()
                .build(),
        )
        setContent {
            val viewModel: SellerHubViewModel = viewModel()
            val state by viewModel.state.collectAsState()
            KeepScreenAwake(state.keepAwake)
            SellerHubTheme {
                SellerHubScreen(
                    state = state,
                    onScan = {
                        scanner.startScan()
                            .addOnSuccessListener { barcode ->
                                barcode.rawValue?.let(viewModel::pair)
                            }
                    },
                    onSync = viewModel::syncNow,
                    onKeepAwake = viewModel::setKeepAwake,
                    onClear = viewModel::clearLocalData,
                )
            }
        }
    }

    @Composable
    private fun KeepScreenAwake(enabled: Boolean) {
        DisposableEffect(enabled) {
            if (enabled) {
                window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            } else {
                window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            }
            onDispose {
                window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            }
        }
    }
}

@Composable
private fun SellerHubScreen(
    state: SellerHubUiState,
    onScan: () -> Unit,
    onSync: () -> Unit,
    onKeepAwake: (Boolean) -> Unit,
    onClear: () -> Unit,
) {
    var confirmClear by remember { mutableStateOf(false) }
    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background)
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 24.dp, vertical = 48.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text(
            text = "LocalClear Seller Hub",
            style = MaterialTheme.typography.headlineLarge,
            fontWeight = FontWeight.ExtraBold,
        )
        Text(
            text = "Marketplace sessions stay on this physical device.",
            style = MaterialTheme.typography.bodyLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        if (!state.paired) {
            HubCard {
                Text("Pair this spare phone", style = MaterialTheme.typography.titleLarge)
                Text(
                    "On the main LocalClear app, open Settings → Seller Hub and create a single-use QR code.",
                )
                Button(onClick = onScan, enabled = !state.busy, modifier = Modifier.fillMaxWidth()) {
                    Text("Scan pairing QR")
                }
                Text(
                    "Scanning uses the Google Code Scanner privacy-preserving system UI. Seller Hub creates a device-bound signing key and never requests marketplace credentials.",
                    style = MaterialTheme.typography.bodySmall,
                )
            }
        } else {
            HubCard {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text("Paired", style = MaterialTheme.typography.titleLarge)
                        Text(
                            state.deviceId.orEmpty(),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    Text("●", color = LocalClearGreen)
                }
                Button(
                    onClick = onSync,
                    enabled = !state.busy,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    if (state.busy) {
                        CircularProgressIndicator(
                            modifier = Modifier.height(20.dp),
                            strokeWidth = 2.dp,
                            color = Color.White,
                        )
                    } else {
                        Text("Sync now")
                    }
                }
            }

            HubCard {
                Text("Last sync", style = MaterialTheme.typography.titleMedium)
                Text(state.lastState.replace('_', ' '))
                Text(
                    state.lastSyncAt ?: "Waiting for first sync",
                    style = MaterialTheme.typography.bodySmall,
                )
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Metric(state.receivedCommands.toString(), "received")
                    Metric(state.completedCommands.toString(), "completed")
                    Metric(state.needsAction.toString(), "needs action")
                }
            }

            HubCard {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text("Keep screen awake", fontWeight = FontWeight.Bold)
                        Text(
                            "Useful while a foreground connector is active.",
                            style = MaterialTheme.typography.bodySmall,
                        )
                    }
                    Switch(checked = state.keepAwake, onCheckedChange = onKeepAwake)
                }
            }

            HubCard {
                Text("Device privacy", style = MaterialTheme.typography.titleMedium)
                Text(
                    "Only fixed, signed actions are accepted. Temporary item photos are hash-checked and deleted after use. No generic remote-control or Accessibility service is present.",
                )
                if (confirmClear) {
                    Text(
                        "This removes the device credential, command history, and device signing key from this phone. Unpair in the main app too.",
                        color = MaterialTheme.colorScheme.error,
                    )
                    Button(
                        onClick = onClear,
                        colors = ButtonDefaults.buttonColors(
                            containerColor = MaterialTheme.colorScheme.error,
                        ),
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text("Confirm clear local data")
                    }
                    OutlinedButton(
                        onClick = { confirmClear = false },
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text("Cancel")
                    }
                } else {
                    OutlinedButton(
                        onClick = { confirmClear = true },
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text("Clear local data")
                    }
                }
            }
        }

        state.error?.let { error ->
            Text(error, color = MaterialTheme.colorScheme.error)
        }
        Spacer(Modifier.height(24.dp))
    }
}

@Composable
private fun HubCard(content: @Composable ColumnScope.() -> Unit) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
    ) {
        Column(
            modifier = Modifier.padding(18.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
            content = content,
        )
    }
}

@Composable
private fun Metric(value: String, label: String) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Text(value, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
        Text(label, style = MaterialTheme.typography.labelSmall)
    }
}

private val LocalClearGreen = Color(0xFF176B4D)

@Composable
private fun SellerHubTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = MaterialTheme.colorScheme.copy(
            primary = LocalClearGreen,
            secondary = Color(0xFFE6A640),
            background = Color(0xFFF7F5EE),
        ),
    ) {
        Surface(content = content)
    }
}
