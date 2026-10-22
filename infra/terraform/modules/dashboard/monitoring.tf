# Email alarms on the dashboard's own App Service, from Azure Monitor, so they also arrive when the app itself
# is down or stuck. Only created when alert_emails is set. The dashboard's Server load page (Admin) shows the
# same load in more detail, with the scans that were running.
locals {
  alerts = length(var.alert_emails) > 0
}

resource "azurerm_monitor_action_group" "alerts" {
  count               = local.alerts ? 1 : 0
  name                = "ag-${var.name}"
  resource_group_name = azurerm_resource_group.this.name
  short_name          = "azops"
  tags                = var.tags

  dynamic "email_receiver" {
    for_each = var.alert_emails
    content {
      name                    = "email-${email_receiver.key}"
      email_address           = email_receiver.value
      use_common_alert_schema = true
    }
  }
}

resource "azurerm_monitor_metric_alert" "cpu" {
  count               = local.alerts ? 1 : 0
  name                = "alert-${var.name}-cpu"
  resource_group_name = azurerm_resource_group.this.name
  scopes              = [azurerm_service_plan.this.id]
  description         = "CPU of the dashboard's App Service plan stayed above ${var.alert_cpu_pct}% for 15 minutes. Check Server load in the dashboard for the scans that ran."
  severity            = 2
  frequency           = "PT5M"
  window_size         = "PT15M"
  tags                = var.tags

  criteria {
    metric_namespace = "Microsoft.Web/serverfarms"
    metric_name      = "CpuPercentage"
    aggregation      = "Average"
    operator         = "GreaterThan"
    threshold        = var.alert_cpu_pct
  }

  action {
    action_group_id = azurerm_monitor_action_group.alerts[0].id
  }
}

resource "azurerm_monitor_metric_alert" "memory" {
  count               = local.alerts ? 1 : 0
  name                = "alert-${var.name}-memory"
  resource_group_name = azurerm_resource_group.this.name
  scopes              = [azurerm_service_plan.this.id]
  description         = "Memory of the dashboard's App Service plan stayed above ${var.alert_memory_pct}% for 15 minutes. Check Server load in the dashboard for the scans that ran."
  severity            = 2
  frequency           = "PT5M"
  window_size         = "PT15M"
  tags                = var.tags

  criteria {
    metric_namespace = "Microsoft.Web/serverfarms"
    metric_name      = "MemoryPercentage"
    aggregation      = "Average"
    operator         = "GreaterThan"
    threshold        = var.alert_memory_pct
  }

  action {
    action_group_id = azurerm_monitor_action_group.alerts[0].id
  }
}

resource "azurerm_monitor_metric_alert" "errors" {
  count               = local.alerts ? 1 : 0
  name                = "alert-${var.name}-5xx"
  resource_group_name = azurerm_resource_group.this.name
  scopes              = [azurerm_linux_web_app.this.id]
  description         = "The dashboard answered with server errors (5xx) more than ${var.alert_5xx_count} times in 15 minutes: it may be down, restarting or out of memory."
  severity            = 1
  frequency           = "PT5M"
  window_size         = "PT15M"
  tags                = var.tags

  criteria {
    metric_namespace = "Microsoft.Web/sites"
    metric_name      = "Http5xx"
    aggregation      = "Total"
    operator         = "GreaterThan"
    threshold        = var.alert_5xx_count
  }

  action {
    action_group_id = azurerm_monitor_action_group.alerts[0].id
  }
}
